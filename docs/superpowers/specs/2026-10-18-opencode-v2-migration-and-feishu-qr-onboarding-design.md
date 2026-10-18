# opencode-lark：接入 opencode v2 + 飞书扫码建应用

- 日期：2026-10-18
- 状态：待评审
- 目标版本：0.4.0

## 1. 背景与目标

`opencode-lark` 目前把飞书群聊与 opencode TUI 会话双向桥接起来。它的代码是为 **opencode v1 的 HTTP API** 写的（根路径 `/session/...`、无鉴权），而本机安装的是 **opencode v2.0.29**，其 API 位于 `/api/*` 前缀下且需要 Basic 鉴权。因此项目当前无法直接接入本机的 opencode。

同时，首次配置必须手工到飞书开放平台创建自建应用、抄 App ID / App Secret、配权限与事件订阅，步骤繁琐。

本次改造做两件事：

1. **接入本机现有 opencode v2 实例**（`http://127.0.0.1:5096`），使用 Basic 鉴权，密码存入 `.env`。
2. **支持扫码自动创建飞书应用**：在设置向导里显示二维码，手机飞书扫码后自动拿到 App ID / App Secret 并写入配置，取代手工输入。

## 2. 非目标

- 不修改 opencode 本身，不要求降级/升级本机 opencode。
- 不对接「另一台机器上的 opencode」或远程鉴权分发。
- 不重写飞书侧的消息、卡片、媒体逻辑（除事件字段名适配外）。
- 不改变现有的会话绑定模型（thread → session，SQLite 持久化）。

## 3. 现状与实测结论

以下均为在本机实际验证过的结论，不是推测：

| 项 | 结论 |
| --- | --- |
| 本机 opencode | v2.0.29，`~/.opencode/bin/opencode`，服务端进程 `opencode serve --port 5096 --hostname 0.0.0.0` |
| 鉴权 | Basic，用户名 `opencode`，密码取自进程环境变量 `OPENCODE_SERVER_PASSWORD`（当前为 `csl251222823`） |
| v2 API 前缀 | `/api/*`；根路径一律返回 HTML（Web UI 兜底路由） |
| 旧 SDK 行为 | `@opencode-ai/sdk@1.2.10` 走根路径，报 `Request is not supported by this version of OpenCode Server (Server responded with text/html)` |
| 新 SDK | `@opencode-ai/sdk@1.19.3` 的客户端带 `client.v2.*` 命名空间，正是 `/api/*`。已实测 `v2.session.list()` / `v2.session.active()` / `v2.agent.list()` / `v2.command.list()` 在带 Basic 鉴权时全部成功 |
| 事件名 | v2 的事件名与项目现有解析完全一致：`message.part.updated`、`message.part.delta`、`session.status`、`session.idle`、`question.asked`、`permission.asked` |
| **事件字段** | **v2 的 `/api/event` 用 `data` 承载载荷，v1 用 `properties`** —— 这是必须适配的差异 |
| `session.status` 取值 | `{type: "idle" \| "busy" \| "retry"}`，与项目现有 busy/idle 处理一致 |
| 子会话 | v2 无 `/api/session/{id}/children`（404）。实测 `GET /api/session?parentID={id}` 可用（未知参数会返回全部会话，`parentID` 会正确过滤） |
| 提问接口 | `/api/session/{id}/question` 与 `/api/question/request` 在本机返回 **404**（`permission` 同类接口返回 200） |
| **载荷与 SDK 类型不一致** | SDK 1.19.3 声明的 `Session` 带 `slug`/`version`/`directory`/`parentID`；而 v2.0.29 实际返回 `location.directory`、`outcome`、`time.idle`/`time.viewed`，**没有 `slug`/`version`/`parentID`**，且列表响应外层是 `{ data, cursor }` 而非裸数组 |
| 飞书注册接口 | `POST https://accounts.feishu.cn/oauth/v1/app/registration` with `action=init` 返回 `supported_auth_methods: ["client_secret", ...]` |

## 4. 总体架构

```
Feishu client
    ↕  WebSocket
Feishu Open Platform
    ↕  WebSocket
opencode-lark
    ├── cli/feishu-onboard.ts   ← 新增：扫码建应用（设备码流程）
    ├── opencode/gateway.ts     ← 新增：唯一的 opencode 访问出口
    ↕  HTTP /api/* + Basic auth
opencode server v2  (127.0.0.1:5096)
    ↕
opencode TUI / Web
```

关键点：**`src/opencode/gateway.ts` 是进程内唯一与 opencode 通信的模块**。其它模块不再拼接 URL、不再直接 `fetch` opencode、不再关心 v2 的路径与鉴权细节。

## 5. Part 1 — opencode v2 gateway

### 5.1 新模块 `src/opencode/gateway.ts`

```ts
export interface OpencodeGatewayOptions {
  baseUrl: string          // http://127.0.0.1:5096
  username?: string        // 默认 "opencode"
  password: string         // OPENCODE_SERVER_PASSWORD
  directory?: string       // OPENCODE_CWD，会转成 x-opencode-directory / location query
}

export interface OpencodeGateway {
  /** 会话 */
  listSessions(query?: { directory?: string; roots?: boolean; limit?: number; scope?: "project" }): Promise<Session[]>
  getSession(sessionID: string): Promise<Session | null>   // 404 → null
  createSession(body: { title?: string; parentID?: string; agent?: string }): Promise<Session>
  children(parentSessionID: string): Promise<Session[]>
  messages(sessionID: string, query?: { limit?: number }): Promise<Message[]>
  sendPrompt(sessionID: string, parts: PromptPart[], opts?: { agent?: string }): Promise<void>
  abort(sessionID: string): Promise<void>
  activeStatuses(): Promise<Record<string, { type: string }>>

  /** 交互 */
  listPermissions(sessionID: string): Promise<PermissionRequest[]>
  replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject", message?: string): Promise<void>
  listQuestions(sessionID: string): Promise<QuestionRequest[]>      // 404 视为「不支持/无待答」
  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void>

  commands(): Promise<Command[]>

  /** 事件 */
  subscribeEvents(signal?: AbortSignal): AsyncIterable<OpencodeEvent>

  /** 探活 */
  ping(): Promise<void>
}
```

实现要点：

- 内部持有 `createOpencodeClient({ baseUrl, directory, headers: { Authorization: "Basic " + base64(username + ":" + password) } })`（来自 `@opencode-ai/sdk/v2`）。
- **优先使用生成的 `client.v2.*` 方法**，路径与参数名由 OpenAPI 生成，避免手工维护 URL。
- 需要 `parts` 之类自定义 body 的调用，若 SDK 方法签名不便，则回退到「带 `/api` 前缀 + 鉴权头」的 `fetch` 封装，集中在本模块内。
- **不要依赖 SDK 声明的响应类型**（见 §3「载荷与 SDK 类型不一致」一行）。在本模块内定义自己的最小类型，例如：

  ```ts
  export interface SessionRef {
    id: string
    title?: string
    agent?: string
    parentID?: string
    location?: { directory?: string }
    time?: { created?: number; updated?: number; idle?: number; viewed?: number }
    model?: { id?: string; providerID?: string }
  }
  ```

  读取一律走可选链，缺字段不抛错。响应外层 `{ data }` 由 gateway 负责拆包，调用方拿到的就是数组/对象。
- 参数名以**真机实测**为准（v2 用 `sessionID`，不是旧版的 `id`）；SDK 的 `.d.ts` 可能滞后于本次服务端版本，实现时逐个端点用真机校验。
- `ping()` 用 `v2.session.active()`（本项目里 `/api/session/status` 返回 400，`active` 才是可用的探活端点；返回 `{ [sessionID]: { type: "idle" | "busy" | "retry" } }`）。
- `getSession` 把 404 转成 `null`，保留 `message-handler` 的「会话已消失 → 自愈重建」语义。
- `listQuestions` 把 404 转成 `[]`，并只告警一次（见 §5.4）。

### 5.2 v1 → v2 接口映射

| 用途 | 旧（v1） | 新（v2） |
| --- | --- | --- |
| 探活 | `GET /session/status` | `GET /api/session/active` |
| 列会话 | `GET /session?roots=true&limit=1&directory=` | `GET /api/session?roots=true&limit=1&directory=` |
| 取会话 | `GET /session/{id}` | `GET /api/session/{sessionID}` |
| 建会话 | `POST /session` | `POST /api/session` |
| 发消息 | `POST /session/{id}/message` | `POST /api/session/{sessionID}/prompt` |
| 中止 | `POST /session/{id}/abort` | `POST /api/session/{sessionID}/interrupt` |
| 子会话 | `GET /session/{id}/children` | `GET /api/session?parentID={sessionID}` |
| 消息列表 | `GET /session/{id}/message?limit=N` | `GET /api/session/{sessionID}/message?limit=N` |
| 事件流 | `GET /event`（`properties`） | `GET /api/event`（`data`） |
| 权限列表 | `GET /permission` | `GET /api/session/{sessionID}/permission`；全局用 `GET /api/permission/request` |
| 权限回复 | `POST /permission/{id}/reply` | `POST /api/session/{sessionID}/permission/{requestID}/reply` |
| 问题列表 | `GET /question` | `GET /api/session/{sessionID}/question`（本机 404，降级） |
| 问题回复 | `POST /question/{id}/reply` | `POST /api/session/{sessionID}/question/{requestID}/reply` |
| 命令 | `GET /command` | `GET /api/command` |

发消息 body 对齐 v2：`{ parts: [...], agent?: string, system?: string, model?: {...} }`（当前代码发的是 `{ parts }`，兼容）。

### 5.3 事件流适配（`properties` → `data`）

事件名不变，仅承载字段名变化。共 12 处，全部收敛为「读 `data`，缺失时回退 `properties`」的单一辅助函数：

```ts
// src/opencode/events.ts
export function eventPayload(event: unknown): Record<string, unknown> | null
```

改动点：

- `src/index.ts`（SSE 分发取 `sessionID`）——同时这里要改为通过 `gateway.subscribeEvents()` 订阅。
- `src/streaming/event-processor.ts`：6 处 `event.properties`。
- `src/streaming/session-observer.ts`：1 处。
- `src/handler/message-handler.ts`：4 处（流式所有权监听）。

保留 `properties` 回退可以让单元测试与旧载荷继续通过，降低回归风险。

### 5.4 已知能力缺口：提问（question）接口

本机 v2.0.29 上 `/api/session/{id}/question` 与 `/api/question/request` 均返回 404，而 `permission` 同类接口正常。含义：

- **权限卡片（permission）功能保留**，行为不变。
- **提问卡片（question）在本机上不可用**。处理方式：
  - `listQuestions` 遇 404 时返回 `[]`，并只在首次打一条 WARN，不刷屏。
  - 事件流里若收到 `question.asked`，仍会渲染卡片；点击回复时若 404，回一条「当前 opencode 版本不支持回答此提问」的提示，而不是静默失败。
  - 在 README 的「已知限制」中说明。

### 5.5 鉴权与配置

新增配置项（写进 `.env`，与现有 `FEISHU_*` 同级）：

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPENCODE_SERVER_URL` | 否 | `http://127.0.0.1:4096` | 已有；本机填 `http://127.0.0.1:5096` |
| `OPENCODE_SERVER_PASSWORD` | v2 必填 | 空 | v2 Basic 鉴权密码 |
| `OPENCODE_SERVER_USERNAME` | 否 | `opencode` | Basic 鉴权用户名 |

- `src/types.ts` + `src/utils/config.ts`：扩展 `AppConfig`，加入 `opencode: { url, username, password, cwd }`。
- 密码缺失时**不再启动失败**，而是打印明确指引（说明 v2 需要 `OPENCODE_SERVER_PASSWORD`，并指向设置向导），保持 v1 无鉴权场景可用。
- `index.ts` 的 `waitForServer()` 改为调用 `gateway.ping()`，重试策略（最多 10 次、指数退避）不变。

### 5.6 涉及改动的模块

`serverUrl: string` 参数统一替换为 `opencode: OpencodeGateway`：

| 模块 | 变化 |
| --- | --- |
| `src/index.ts` | 构造 gateway；SSE 订阅改走 gateway |
| `src/session/session-manager.ts` | 3 处 fetch → gateway |
| `src/streaming/subagent-tracker.ts` | 2 处 fetch（children / messages）→ gateway |
| `src/handler/message-handler.ts` | 2 处发消息 fetch → `gateway.sendPrompt`；4 处事件字段 |
| `src/handler/command-handler.ts` | 建会话 / 中止 / 校验 → gateway |
| `src/handler/interactive-handler.ts` | 问题/权限回复 → gateway |
| `src/handler/interactive-poller.ts` | 轮询问题/权限 → gateway |
| `src/cron/cron-service.ts` | 3 处 → gateway |
| `src/cron/heartbeat.ts` | 1 处 → gateway.ping |

## 6. Part 2 — 飞书扫码建应用

### 6.1 新模块 `src/cli/feishu-onboard.ts`

移植自 Hermes 的 `plugins/platforms/feishu/adapter.py` 设备码流程：

```ts
export interface OnboardResult {
  appId: string
  appSecret: string
  domain: "feishu" | "lark"
  openId?: string
  botName?: string
}

export async function qrRegister(opts?: {
  domain?: "feishu" | "lark"
  timeoutSeconds?: number      // 默认 600
  onQrUrl?: (url: string) => void
}): Promise<OnboardResult | null>
```

流程：

1. `POST {action:"init"}` → 校验 `supported_auth_methods` 含 `client_secret`，否则报错退出。
2. `POST {action:"begin", archetype:"PersonalAgent", auth_method:"client_secret", request_user_info:"open_id"}` → `device_code`、`verification_uri_complete`（二维码 URL）、`user_code`、`interval`、`expire_in`。
3. 终端渲染二维码（见 §6.3）。
4. 每 `interval` 秒 `POST {action:"poll", device_code, tp:"ob_app"}` 轮询：
   - 返回 `client_id` + `client_secret` → 完成。
   - `user_info.tenant_brand === "lark"` → 切到 `accounts.larksuite.com` 继续轮询（自动识别国际版）。
   - `error` 为 `access_denied` / `expired_token` → 返回 `null`。
   - 其余（`authorization_pending`）→ 继续。
5. 拿到凭据后 best-effort 探活机器人（`tenant_access_token` → `/open-apis/bot/v3/info`）取 `botName`。
6. `expire_in` 与 `timeoutSeconds` 取小者作为总超时。

端点常量：

```ts
const ACCOUNTS_URLS = { feishu: "https://accounts.feishu.cn", lark: "https://accounts.larksuite.com" }
const REGISTRATION_PATH = "/oauth/v1/app/registration"
const OPEN_URLS = { feishu: "https://open.feishu.cn", lark: "https://open.larksuite.com" }
```

请求为 `application/x-www-form-urlencoded`；**轮询的「待授权」是 4xx，必须解析错误响应体**，不能只看状态码。

### 6.2 接入设置向导

`src/cli/setup-wizard.ts` 的 Step 1 改为二选一：

```
Step 1/3: Feishu Credentials
  1. 扫码自动创建应用（推荐）
  2. 手动输入 App ID / App Secret
```

- 选 1 → `qrRegister()`；成功则跳过手工输入，直接把 `appId` / `appSecret` 用于后续步骤；失败或超时 → 提示并回退到手动输入。
- 选 2 → 保持现有行为不变。
- 非 TTY 环境（`process.stdin.isTTY !== true`）不提供扫码选项，直接走手动输入。

### 6.3 二维码渲染

新增依赖 **`qrcode-terminal`**（纯 JS，无原生依赖，体积小）：

```ts
import qrcode from "qrcode-terminal"
qrcode.generate(url, { small: true })
```

失败时降级为打印 URL 原文，并提示「也可直接在手机飞书里打开此链接」。这是本次唯一新增的运行时依赖。

### 6.4 向导保存的配置

`.env.<appId>` 追加：

```
OPENCODE_SERVER_URL=http://127.0.0.1:5096
OPENCODE_SERVER_PASSWORD=<password>
```

向导的 Step 2（opencode 连接检查）改为调用 `/api/session/active`（带鉴权），替代当前对 `serverUrl` 根路径的 `fetch(serverUrl)`（根路径在 v2 下会返回 HTML，无法反映真实连通性）。

## 7. 错误处理

| 场景 | 行为 |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` 缺失 | 启动告警 + 指引，不崩溃 |
| opencode 不可达 | 保留现有 10 次指数退避重试；失败则退出并给出可执行的修复提示 |
| 鉴权失败（401） | 错误信息明示「密码错误或未设置 `OPENCODE_SERVER_PASSWORD`」，不重试 |
| 会话 404 | 保留现有自愈：清映射 → 重新解析 → 重试一次 |
| question 接口 404 | 视为不支持，告警一次，功能降级 |
| SSE 断流 | 保留现有行为（记录并结束），不做自动重连（与现状一致） |
| 扫码超时/拒绝 | 返回 `null`，向导回退手动输入，不影响流程继续 |
| 注册接口网络错误 | 同上；不抛未捕获异常 |

## 8. 测试策略

- **`src/opencode/__tests__/gateway.test.ts`（新）**：以 fake `fetch` 断言 URL 带 `/api` 前缀、Authorization 头正确、`{ data }` 外层被正确拆包、404 → `null` / `[]`、`children` 发出的查询串包含 `parentID=`。
- **`src/opencode/__tests__/events.test.ts`（新）**：`eventPayload` 对 `data` / `properties` / 空载荷的行为。
- **`src/cli/__tests__/feishu-onboard.test.ts`（新）**：mock `fetch`，覆盖 init 不支持 `client_secret`、begin、轮询到成功、`access_denied`、超时、lark 域自动切换、4xx 响应体解析。
- **现有测试**：8 个模块的测试从「mock 全局 fetch + 匹配 URL」改为「注入 fake gateway」。事件相关测试的载荷补 `data` 字段，同时保留 `properties` 用例以验证回退。
- **回归**：`bun run test:run` 全绿；`src/__tests__/e2e/smoke.test.ts` 用 fake gateway 跑通。
- **人工验证**：对本机 5096 真机跑一次——发一条飞书消息，确认 TUI 收到、回复流式回卡片。

## 9. 迁移步骤

1. 升级依赖：`@opencode-ai/sdk` → `^1.19.3`，新增 `qrcode-terminal`。
2. 新增 `src/opencode/gateway.ts` + `src/opencode/events.ts` 及其测试。
3. 扩展配置（`types.ts` / `config.ts`）与 `.env.example`。
4. 逐个模块替换 `serverUrl` → `gateway`，每替换一个跑一次相关测试。
5. 12 处事件字段改为 `eventPayload()`。
6. 新增 `src/cli/feishu-onboard.ts` + 测试。
7. 改造 `setup-wizard.ts`（Step 1 扫码、Step 2 鉴权探活、Step 3 写新变量）。
8. 更新 `README.md` / `README.zh-CN.md` / `AGENTS.md`：v2 接入说明、鉴权配置、扫码流程、已知限制（question）。
9. 端到端真机验证。

## 10. 风险与未决问题

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 扫码创建的应用可能仍需在飞书后台确认「长连接」事件/回调订阅 | 机器人收不到消息 | 使用 `PersonalAgent` 预设（Hermes 已验证可用）；真机扫码后验证；README 给出排查步骤 |
| `sendPrompt` 的 parts 结构在 v2 下可能对 `FilePartInput` / `AgentPartInput` 有额外必填字段 | 图片/文件消息失败 | 实现时用真机逐类型验证；图片走 `FilePartInput`，其余保持 text |
| question 接口在本机不可用 | 提问卡片功能降级 | 已在 §5.4 明确降级策略并写入 README |
| SDK 1.19.3 的类型定义与 v2.0.29 实际载荷不一致（`location.directory`、缺 `slug`/`version`/`parentID`） | 依赖类型的地方在运行时空值/报错 | gateway 内自定义宽松类型 + 可选链；**不 import SDK 的响应类型**；每个端点在真机校验一次 |
| `children` 改用 `?parentID=`，返回项**不含** `parentID` 字段，无法二次校验归属 | 极端情况下取到意外会话 | 只取返回数组中最后一项（与旧逻辑一致）；真机对比子代理数据 |
| 现有测试大量依赖 URL 匹配的 fetch mock | 改造噪音大 | 分模块小步替换，逐个跑测试，不一次性全改 |
| 扫码流程会真实创建飞书应用 | 误建应用 | 仅在用户主动选择扫码时调用；失败/超时不留残余配置；不自动重试创建 |

## 11. 验收标准

1. `bun run start` 能连接到 `http://127.0.0.1:5096`（带 Basic 鉴权），启动日志显示连接成功，并成功列出本机会话。
2. 在飞书里给机器人发一条文本，opencode 会话收到该消息，回复以流式卡片返回飞书。
3. 权限卡片（permission）可点击并生效。
4. 全新环境下运行 `init`，选择扫码 → 终端出现二维码 → 手机飞书扫码 → 自动写入 `.env.<appId>` 并成功启动。
5. `bun run test:run` 全部通过。
6. 未设置 `OPENCODE_SERVER_PASSWORD` 时启动有清晰指引而非堆栈报错。
