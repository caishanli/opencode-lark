# opencode-lark：接入 opencode v2 + 飞书扫码建应用

- 日期：2026-10-18
- 状态：已校准（已对照本机 openapi.json / stub-fetch 实测）
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
| 权威契约 | 本机 `GET /openapi.json`（200，OpenAPI 3.1.0，`opencode HttpApi 0.0.1`，118 条路径）就是服务端自述的契约，优先于 SDK 的 `.d.ts` |
| 事件名 | **与 v1 不完全一致**：文本增量是 `session.next.text.delta`，权限是 `permission.v2.asked`，提问是 `question.v2.asked`；`message.part.updated` / `session.idle` / `session.status` 保持不变。完整映射见 §5.3 |
| **事件字段** | **v2 的 `/api/event` 用 `data` 承载载荷（v1 用 `properties`）**。注意 SDK 自己的类型也不统一（`session.next.*` 用 `data`，`permission.v2.asked` 却写 `properties`），所以必须 **`data ?? properties` 两边都读** |
| `session.status` 取值 | 事件载荷里是 `{type: "idle" \| "busy" \| "retry"}`，与现有 busy/idle 处理一致 |
| 活跃状态接口 | `GET /api/session/active` 实测返回 `{"data":{"ses_xxx":{"type":"running"}}}` —— **值是 `running`，不是 `idle`/`busy`**（openapi 里的枚举已过时）。语义：**出现在 map 里 = 该会话正在跑，缺席 = 不活跃** |
| 子会话 | v2 无 `/api/session/{id}/children`（404）。`GET /api/session?parentID={id}` 可用（实测带 `parentID` 会正确过滤，返回 `{data:[],cursor:{...}}`） |
| 提问接口 | `/api/session/{id}/question`、`/api/question/request` 均 **404**；`/api/permission/request`、`/api/session/{id}/permission` 均 200。SDK 1.19.3 里有这些 question 路由，说明 **SDK 比服务端新** |
| 发消息 body | `POST /api/session/{sessionID}/prompt` 要 **`{ text, files?, agents?, skills?, delivery?, resume? }`**，`text` 必填。**不是** `{ parts: [...] }`：实测发 `{}` / `{"parts":[…]}` 都返回 `400 Missing key at ["text"]` |
| 附件 | 仍支持，形状是 `files: [{ uri, name?, description? }]`（`uri` 必填），**不是** v1 的 `FilePartInput{mime,url}` |
| 列表信封 | 列表统一 `{ data, cursor }`；`/api/permission/request`、`/api/agent`、`/api/command` 是 `{ location, data }`；`cursor` 是对象 `{previous,next}` 而非字符串 |
| **SDK 调用约定（实测）** | `client.v2.*` 的真实用法与它自己的 `.d.ts` **不符**，必须按实测写：<br>① 路径参数**平铺**传（`{ sessionID }`），不是 `{ path: { sessionID } }`；<br>② SDK 会**静默丢弃**它没声明的参数（`parentID`、`type`、`prompt` 的 `text`…），要用 `$query_xxx` / `$body_xxx` 前缀逃生口；<br>③ 返回是 `{ data, request, response }`，而服务端 body 又是 `{ data }`，所以取数要 **`res.data.data`**；<br>④ 4xx 不抛异常，而是返回 `{ error, response }`，判断 `res.error`；<br>⑤ `location` 查询参数序列化为 `location[directory]=…`；<br>⑥ `headers` 里的 Basic 鉴权由 `createOpencodeClient({ headers })` 注入 |
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
  listSessions(query?: { directory?: string; parentID?: string; limit?: number; search?: string }): Promise<Session[]>
  getSession(sessionID: string): Promise<Session | null>   // 404 → null
  createSession(body: { title?: string; parentID?: string; agent?: string; directory?: string }): Promise<Session>
  children(parentSessionID: string): Promise<Session[]>     // 内部 listSessions({ parentID })
  messages(sessionID: string, query?: { limit?: number; order?: "asc" | "desc"; type?: string }): Promise<Message[]>
  sendPrompt(sessionID: string, input: PromptInput, opts?: { delivery?: "steer" | "queue" }): Promise<void>
  abort(sessionID: string): Promise<void>
  activeStatuses(): Promise<Record<string, { type: string }>>

  /** 交互 */
  listPermissions(): Promise<PermissionRequest[]>        // 全局待处理：GET /api/permission/request
  replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject", message?: string): Promise<void>
  listQuestions(): Promise<QuestionRequest[]>            // 全局待处理；本机 404 视为「不支持」，返回 []
  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void>

  commands(): Promise<Command[]>

  /** 事件 */
  subscribeEvents(signal?: AbortSignal): AsyncIterable<OpencodeEvent>

  /** 探活 */
  ping(): Promise<void>
}
```

实现要点：

- 内部持有 `createOpencodeClient({ baseUrl, headers: { Authorization: "Basic " + base64(username + ":" + password) } })`（来自 `@opencode-ai/sdk/v2`）。鉴权头通过 `headers` 注入，不要依赖 SDK 的 auth 配置。
- **每个方法都用 `client.v2.*`**，但签名按§下表实测写法，不能照抄 `.d.ts`。SDK 未声明的参数会被**静默丢弃**，一律用 `$body_*` / `$query_*` 逃生口显式传递。
- **不要依赖 SDK 的响应类型**。在本模块内定义自己的最小类型，读取一律走可选链，缺字段不抛错：

  ```ts
  export interface PromptInput {
    text: string
    files?: Array<{ uri: string; name?: string }>
    agents?: Array<{ name: string }>
  }

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

- 拆包：响应是 `{ data, request, response }`，服务端 body 又是 `{ data }`（或 `{ location, data }`），所以统一 **`res.data.data`** 才是业务数据；`res.error` 非空表示失败（SDK 4xx 不抛异常）。
- `ping()` 用 `v2.session.active()`（v2 无 `/api/session/status`）；判活是「在不在 map 里」，不要判 `type` 的字面值。
- **SDK 对 4xx 不抛异常**（返回 `{ error, response }`）。因此 `ping()` 必须显式检查 `res.error` 并抛出（401 提示检查 `OPENCODE_SERVER_PASSWORD`），否则密码错误时 `waitForServer` 会误报「已就绪」。同理 `listPermissions` / `commands` / `listQuestions`（404 除外）遇错要抛，避免轮询把「请求失败」误当成「无待处理项」而错误地把卡片标记为已解决。
- `listSessions` 用于会话发现时要传 `parentID: "null"`：v2 没有 v1 的 `roots=true`，不传会把子/子代理会话当成根会话绑定。
- `getSession` 把 404 转成 `null`，保留 `message-handler` 的「会话已消失 → 自愈重建」语义。
- `listQuestions` 把 404 转成 `[]`，并只告警一次（见 §5.4）。

#### 实测调用矩阵（照抄即可）

以下签名全部用 stub `fetch` 抓取真实 URL/body 验证过，**零副作用**：

| gateway 方法 | SDK 调用 | 线上实际请求 |
| --- | --- | --- |
| `listSessions({directory})` | `v2.session.list({ directory })` | `GET /api/session?directory=…` |
| `children(id)` | `v2.session.list({ $query_parentID: id })` | `GET /api/session?parentID=…` |
| `getSession(id)` | `v2.session.get({ sessionID: id })` | `GET /api/session/{id}` |
| `createSession({title,directory})` | `v2.session.create({ location:{directory}, $body_title: title })` | `POST /api/session` body `{"location":{…},"title":…}` |
| `activeStatuses()` | `v2.session.active()` | `GET /api/session/active` |
| `sendPrompt(id,{text,files})` | `v2.session.prompt({ sessionID:id, $body_text:text, $body_files, $body_delivery })` | `POST …/prompt` body `{"text":…,"files":[…]}` |
| `abort(id)` | `v2.session.interrupt({ sessionID:id })` | `POST …/interrupt` |
| `messages(id,{limit,order,type})` | `v2.session.messages({ sessionID:id, limit, order, $query_type })` | `GET …/message?limit&order&type` |
| `listPermissions()` | `v2.permission.request.list({ location:{directory} })` | `GET /api/permission/request?location[directory]=…` |
| `replyPermission(sid,rid,decision)` | `v2.session.permission.reply({ sessionID:sid, requestID:rid, $body_decision:decision })` | `POST …/permission/{rid}/reply` body `{"decision":…}` |
| `listQuestions()` | `v2.question.request.list({ location:{directory} })` | `GET /api/question/request`（本机 404） |
| `replyQuestion(sid,rid,answers)` | `v2.session.question.reply({ sessionID:sid, requestID:rid, $body_answers:answers })` | `POST …/question/{rid}/reply`（本机 404） |
| `commands()` | `v2.command.list({ location:{directory} })` | `GET /api/command?location[directory]=…` |
| `subscribeEvents()` | `v2.event.subscribe({ signal })` | `GET /api/event`（SSE） |

注意 `createSession` 的 `title` 与 `prompt` 的 `text`/`files` 都必须走 `$body_*`：SDK 为这两个方法声明的是 `title`→(未声明)、`prompt`→`body.prompt`，直接传会被丢弃或发成服务端不认的形状。

### 5.2 v1 → v2 接口映射

| 用途 | 旧（v1） | 新（v2） |
| --- | --- | --- |
| 探活 | `GET /session/status` | `GET /api/session/active` |
| 列会话 | `GET /session?roots=true&limit=1&directory=` | `GET /api/session?limit=1&directory=`（v2 无 `roots` 参数，直接按 `directory` 过滤） |
| 取会话 | `GET /session/{id}` | `GET /api/session/{sessionID}` |
| 建会话 | `POST /session` | `POST /api/session` |
| 发消息 | `POST /session/{id}/message` | `POST /api/session/{sessionID}/prompt` |
| 中止 | `POST /session/{id}/abort` | `POST /api/session/{sessionID}/interrupt` |
| 子会话 | `GET /session/{id}/children` | `GET /api/session?parentID={sessionID}` |
| 消息列表 | `GET /session/{id}/message?limit=N` | `GET /api/session/{sessionID}/message?limit=N` |
| 事件流 | `GET /event`（`properties`） | `GET /api/event`（`data`） |
| 权限列表 | `GET /permission` | `GET /api/permission/request`（全局待处理） |
| 权限回复 | `POST /permission/{id}/reply` | `POST /api/session/{sessionID}/permission/{requestID}/reply` |
| 问题列表 | `GET /question` | `GET /api/question/request`（本机 404，降级） |
| 问题回复 | `POST /question/{id}/reply` | `POST /api/session/{sessionID}/question/{requestID}/reply` |
| 命令 | `GET /command` | `GET /api/command` |

发消息 body **结构变了**：v1 是 `{ parts: [{type:"text",text},{type:"file",mime,url}] }`，v2 是 `{ text: string, files?: [{uri,name?}], agents?, skills?, delivery?, resume? }`。所以 `message-handler` 里拼 `parts` 的那段要改成「文本 + `files[{uri}]`」。

`files[].uri` 的取值形式（`file://` 绝对路径还是 data URI）**未实测**——真机验证一次；图片附件沿用现有「先落盘再传」的流程，只是最后一步换个字段名。

**回复接口需要 sessionID。** v2 的权限/问题回复端点路径里带 `{sessionID}`，而现有卡片按钮的 action value 只带 `requestId`。因此：

- `buildPermissionCard` / `buildQuestionCard` 的按钮 value 增加 `sessionId`（构建时 `action.sessionId` 已知）。
- `interactive-handler` 读取 `value.sessionId` 调用 gateway；缺失时记一条 WARN 并放弃（不猜测归属，避免答错会话）。
- 列表仍是全局查询（与现有轮询行为一致），不做按会话拆分。

### 5.3 事件流适配（`properties` ↔ `data`）

事件名**不是**完全不变，载荷位置也不是只有 `data`。SDK 自身的类型也相互矛盾（`session.next.*` / `session.idle` 用 `data`，`permission.v2.asked` / `question.v2.asked` 却写 `properties`），而本机 `/api/event` 用 `data`。因此 helper 必须 **`data ?? properties` 双读**，并把 v1/v2 事件名都识别。

```ts
// src/opencode/events.ts
export function eventPayload(event: unknown): Record<string, unknown> | null
```

映射表（`event-processor.ts` 按此重写）。**实测（本机 v2.0.29 二进制 + 实时抓帧）确认：事件名前缀是 `session.text.*` / `session.tool.*`，不是 SDK `.d.ts` 里的 `session.next.*`（后者在本机二进制里出现 0 次）。**

| 旧（v1） | 新（v2.0.29 实测） | 载荷位置 | 处理 |
| --- | --- | --- | --- |
| `message.part.updated` | `message.part.updated` | `data.part`、`data.delta` | TextDelta（`part.type==="text"` + delta）、ToolStateChange、SubtaskDiscovered（保留，向前兼容） |
| `message.part.delta` | `message.part.delta` | `data.sessionID/messageID/partID/field/delta` | TextDelta（`field==="text"`） |
| — | **`session.text.delta`** | `data.sessionID`、`data.delta` | TextDelta（v2 主路径） |
| — | `session.text.started` / `session.text.ended` | `data.text` | 忽略（`ended` 带全文，非增量） |
| — | `session.tool.called` | `data.sessionID`、`data.callID`、`data.tool`、`data.input` | ToolStateChange（running）；记录 callID→tool |
| — | `session.tool.success` / `session.tool.failed` | `data.sessionID`、`data.callID`、`data.error?` | ToolStateChange（completed / error），tool 名从 map 取 |
| `session.status` | `session.status` | `data.sessionID`、`data.status` | busy/idle/running → SessionIdle |
| `session.idle` | `session.idle` | `data.sessionID` | SessionIdle |
| `question.asked` | **无 `question.*` 事件**（本机只有 `form.*`） | — | 提问卡片在本机不可用（见 §5.4） |
| `permission.asked` | `permission.asked`（**不是** `permission.v2.asked`） | `data.id`、`data.sessionID`、`data.action`、`data.resources`、`data.metadata` | PermissionRequested；`permissionType=data.action`，`title=data.resources.join(", ")` |

`PermissionRequested` 仍带 `permissionType` 供卡片展示，从 `action` 取（兼容旧 `permission` 字段）；`metadata` 缺失时用 `{}`。

改动点：

- `src/index.ts`（SSE 分发取 `sessionID`）——同时改为通过 `gateway.subscribeEvents()` 订阅。
- `src/streaming/event-processor.ts`：6 处 `event.properties` → `eventPayload()`；事件名 switch 更新；`reasoningPartIds` 跟踪仍保留（`message.part.delta` 对 reasoning 的过滤），但 `session.next.text.delta` 路径不触发它。
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
| `src/handler/interactive-handler.ts` | 问题/权限回复 → gateway（需从 action value 取 `sessionId`） |
| `src/handler/streaming-integration.ts` | `buildPermissionCard` / `buildQuestionCard` 的按钮 value 增加 `sessionId` |
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
| `sendPrompt` 的 `files[].uri` 形式（`file://` vs data URI）未在真机验证 | 图片/文件消息失败 | 实现时用真机逐类型验证；图片走 `files:[{uri}]`，其余保持 text；已有落盘逻辑复用 |
| question 接口在本机不可用（`question.v2.asked` 事件仍会到达） | 提问卡片功能降级 | `listQuestions` 遇 404 返回 `[]`；卡片回复时 404 → 回「当前 opencode 版本不支持回答此提问」；写入 README「已知限制」 |
| SDK `.d.ts` 与 v2.0.29 不一致（参数被静默丢弃、`data` 双层拆包、4xx 不抛异常） | 实现时踩坑 | gateway 按§5.1 实测矩阵写，每个方法配 stub-fetch 单元测试锁定 URL/body |
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
