# 实施计划：opencode-lark 接入 opencode v2 + 飞书扫码建应用

> **给执行者的说明：** 本计划假设执行者**从未见过本仓库**。每一步都写明文件、签名、取值与验收命令。按 TDD 走：先写失败的测试，再写实现，再跑测试，再提交。每完成一个任务就 `git commit`。

- **目标：** 让 `opencode-lark` 能连接本机 `opencode serve`（v2.0.29，`http://127.0.0.1:5096`，Basic 鉴权），并新增飞书扫码创建应用的 onboarding 流程。
- **架构：** 新增 `src/opencode/gateway.ts` 作为进程内唯一的 opencode 访问出口；所有 `serverUrl`/`fetch(opencode)` 调用统一改为注入 `OpencodeGateway`。新增 `src/opencode/events.ts` 集中 `properties`↔`data` 适配。新增 `src/cli/feishu-onboard.ts` 移植 Hermes 设备码流程。
- **技术栈：** Bun 1.4.x、TypeScript 5.7、vitest 2、`@opencode-ai/sdk@^1.19.3`、`qrcode-terminal`（新增）、`@larksuiteoapi/node-sdk`。
- **权威契约：** 本机 `GET /openapi.json`（OpenAPI 3.1.0，`opencode HttpApi 0.0.1`）。SDK 的 `.d.ts` 与服务端 **不一致**，必须按本计划的矩阵写；任何 `fetch`/URL/参数都以 openapi + stub-fetch 实测为准。
- **前置条件：** `opencode serve --port 5096 --hostname 0.0.0.0` 正在运行，密码来自 `OPENCODE_SERVER_PASSWORD`（当前 `csl251222823`）。

## 0. 文件地图

**新增：**
- `src/opencode/gateway.ts` — 唯一 opencode 访问出口
- `src/opencode/events.ts` — `eventPayload()` 辅助
- `src/opencode/__tests__/gateway.test.ts`
- `src/opencode/__tests__/events.test.ts`
- `src/cli/feishu-onboard.ts` — 扫码建应用
- `src/cli/__tests__/feishu-onboard.test.ts`

**修改：**
- `package.json`（依赖）
- `src/types.ts`、`src/utils/config.ts`、`.env.example`
- `src/index.ts`（构造 gateway、SSE 订阅、`waitForServer`）
- `src/session/session-manager.ts`
- `src/streaming/subagent-tracker.ts`
- `src/handler/message-handler.ts`
- `src/handler/command-handler.ts`
- `src/handler/interactive-handler.ts`
- `src/handler/interactive-poller.ts`
- `src/handler/streaming-integration.ts`（按钮 value 加 `sessionId`）
- `src/streaming/session-observer.ts`
- `src/cron/cron-service.ts`
- `src/cron/heartbeat.ts`
- `src/cli/setup-wizard.ts`

**不动：** 飞书消息/卡片/媒体逻辑、会话绑定模型、SQLite。

---

## 任务 1：依赖 bump + 配置扩展

**文件：** `package.json`、`src/types.ts`、`src/utils/config.ts`、`.env.example`、`src/__tests__/config.test.ts`（若存在）

**Step 1：写失败的测试。** 在 `src/__tests__/config.test.ts`（不存在则新建）追加：

```ts
import { loadConfig } from "../utils/config.js"
test("v2: reads OPENCODE_SERVER_PASSWORD/USERNAME into opencode config", () => {
  process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:5096"
  process.env.OPENCODE_SERVER_PASSWORD = "secret"
  process.env.OPENCODE_SERVER_USERNAME = "opencode"
  const cfg = loadConfig()
  expect(cfg.opencode.url).toBe("http://127.0.0.1:5096")
  expect(cfg.opencode.password).toBe("secret")
  expect(cfg.opencode.username).toBe("opencode")
})
```

**Step 2：跑测试确认失败。** `bun node_modules/.bin/vitest run src/__tests__/config.test.ts`。

**Step 3：实现。**

`package.json` dependencies：
- `"@opencode-ai/sdk": "^1.19.3"`
- 新增 `"qrcode-terminal": "^0.12.0"`

`src/types.ts` 的 `AppConfig` 追加：
```ts
opencode: {
  url: string
  username: string
  password: string
  cwd: string
}
```

`src/utils/config.ts`：
```ts
opencode: {
  url: process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096",
  username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
  password: process.env.OPENCODE_SERVER_PASSWORD ?? "",
  cwd: process.env.OPENCODE_CWD ?? process.cwd(),
}
```
（缺失密码不抛错；启动时由 `index.ts` 告警。）

`.env.example` 追加：
```
OPENCODE_SERVER_URL=http://127.0.0.1:5096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
```

**Step 4：跑测试确认通过。**

**Step 5：提交。** `git add -A && git commit -m "feat(config): add opencode v2 auth fields + bump sdk"`

---

## 任务 2：`src/opencode/events.ts` + 测试

**文件：** `src/opencode/events.ts`、`src/opencode/__tests__/events.test.ts`

**Step 1：写失败的测试。**

```ts
import { eventPayload } from "../events.js"
test("prefers data over properties", () => {
  expect(eventPayload({ type: "x", data: { a: 1 }, properties: { a: 2 } })).toEqual({ a: 1 })
})
test("falls back to properties", () => {
  expect(eventPayload({ type: "x", properties: { a: 2 } })).toEqual({ a: 2 })
})
test("returns null for missing/empty payload", () => {
  expect(eventPayload({ type: "x" })).toBeNull()
  expect(eventPayload(null)).toBeNull()
  expect(eventPayload("str")).toBeNull()
})
```

**Step 2：跑，确认失败。**

**Step 3：实现。**

```ts
// src/opencode/events.ts
export function eventPayload(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null
  const e = event as Record<string, unknown>
  const d = e.data
  if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>
  const p = e.properties
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>
  return null
}
```

**Step 4：跑，通过。**

**Step 5：提交。** `git commit -m "feat(opencode): add eventPayload helper (data ?? properties)"`

---

## 任务 3a：`src/opencode/gateway.ts` — 会话操作

**文件：** `src/opencode/gateway.ts`、`src/opencode/__tests__/gateway.test.ts`

**Step 1：写失败的测试（先写 §3a 范围内）。** 用 stub `fetch`（不发网络），断言 URL、Authorization 头、拆包。

```ts
import { vi } from "vitest"
import { createOpencodeGateway } from "../gateway.js"

function makeFetch(body: unknown, status = 200) {
  return vi.fn(async (req: Request) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }))
}

test("listSessions: /api prefix + auth + unwraps {data:{data,cursor}}", async () => {
  const fetchImpl = makeFetch({ data: { data: [{ id: "s1", title: "t" }], cursor: null } })
  const gw = createOpencodeGateway({ baseUrl: "http://X", password: "pw", username: "opencode", fetch: fetchImpl as any })
  const res = await gw.listSessions({ directory: "/tmp" })
  const req = fetchImpl.mock.calls[0][0] as Request
  expect(req.url).toBe("http://X/api/session?directory=%2Ftmp")
  expect(req.headers.get("authorization")).toBe("Basic " + btoa("opencode:pw"))
  expect(res).toEqual([{ id: "s1", title: "t" }])
})

test("children: query string contains parentID=", async () => {
  const fetchImpl = makeFetch({ data: { data: [], cursor: null } })
  const gw = createOpencodeGateway({ baseUrl: "http://X", password: "pw", fetch: fetchImpl as any })
  await gw.children("ses_parent")
  expect((fetchImpl.mock.calls[0][0] as Request).url).toContain("parentID=ses_parent")
})

test("getSession: 404 -> null", async () => {
  const fetchImpl = makeFetch({ error: "SessionNotFoundError" }, 404)
  const gw = createOpencodeGateway({ baseUrl: "http://X", password: "pw", fetch: fetchImpl as any })
  expect(await gw.getSession("ses_x")).toBeNull()
})

test("activeStatuses: unwraps .data.data", async () => {
  const fetchImpl = makeFetch({ data: { data: { "ses_a": { type: "running" } } } })
  const gw = createOpencodeGateway({ baseUrl: "http://X", password: "pw", fetch: fetchImpl as any })
  expect(await gw.activeStatuses()).toEqual({ "ses_a": { type: "running" } })
})
```

**Step 2：跑，失败。**

**Step 3：实现 §3a 部分。** `src/opencode/gateway.ts`：

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

export interface OpencodeGatewayOptions {
  baseUrl: string
  username?: string
  password: string
  directory?: string
  fetch?: typeof fetch
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

export interface PromptInput {
  text: string
  files?: Array<{ uri: string; name?: string }>
  agents?: Array<{ name: string }>
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean; custom?: boolean }>
}

export interface CommandRef { name: string; description?: string }

export type OpencodeEvent = { id?: string; type: string; data?: Record<string, unknown>; properties?: Record<string, unknown> }

export interface OpencodeGateway { /* 全部方法，见 §5.1 */ }

export function createOpencodeGateway(options: OpencodeGatewayOptions): OpencodeGateway {
  const client = createOpencodeClient({
    baseUrl: options.baseUrl,
    headers: { Authorization: "Basic " + btoa(`${options.username ?? "opencode"}:${options.password}`) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }) as any

  const unwrap = (res: any) => (res?.data?.data ?? res?.data ?? null)
  const ok = (res: any) => !res?.error

  return {
    async listSessions(query = {}) {
      const res = await client.v2.session.list({ directory: query.directory ?? options.directory, limit: query.limit, search: query.search, $query_parentID: query.parentID })
      return (unwrap(res) as SessionRef[] | null) ?? []
    },
    async children(parentSessionID) {
      return this.listSessions({ parentID: parentSessionID })
    },
    async getSession(sessionID) {
      const res = await client.v2.session.get({ sessionID })
      if (res?.error) return null
      return unwrap(res) as SessionRef | null
    },
    async createSession(body = {}) {
      const res = await client.v2.session.create({
        location: { directory: body.directory ?? options.directory ?? process.cwd() },
        $body_title: body.title,
        $body_agent: body.agent,
        $body_parentID: body.parentID,
      })
      return unwrap(res) as SessionRef
    },
    async activeStatuses() {
      const res = await client.v2.session.active()
      return (unwrap(res) as Record<string, { type: string }>) ?? {}
    },
    async messages(sessionID, query = {}) {
      const res = await client.v2.session.messages({ sessionID, limit: query.limit, order: query.order, $query_type: query.type })
      const body = res?.data ?? {}
      return (body.data ?? []) as any[]
    },
    async sendPrompt(sessionID, input, opts = {}) {
      const res = await client.v2.session.prompt({
        sessionID,
        $body_text: input.text,
        $body_files: input.files,
        $body_agents: input.agents,
        $body_delivery: opts.delivery,
      })
      if (res?.error) throw new Error(res.error?.message ?? "sendPrompt failed")
    },
    async abort(sessionID) {
      await client.v2.session.interrupt({ sessionID })
    },
    // 3b/3c 在后续任务追加
  } as OpencodeGateway
}
```

> 注意：上面是 3a 范围；3b/3c 任务把交互与事件方法追加到同一个对象里。实现时把所有方法放在一个 `createOpencodeGateway` 里。

**Step 4：跑测试，通过。**

**Step 5：提交。** `git commit -m "feat(opencode): gateway session ops"`

---

## 任务 3b：gateway 交互方法

**文件：** `src/opencode/gateway.ts`、`src/opencode/__tests__/gateway.test.ts`

**追加方法：**

```ts
async listPermissions() {
  const res = await client.v2.permission.request.list({ location: { directory: options.directory ?? process.cwd() } })
  const body = res?.data ?? {}
  return (body.data ?? []) as PermissionRequest[]
},
async replyPermission(sessionID, requestID, reply, message) {
  const res = await client.v2.session.permission.reply({
    sessionID, requestID, $body_decision: reply, $body_message: message,
  })
  if (res?.error) throw new Error(res.error?.message ?? "replyPermission failed")
},
async listQuestions() {
  const res = await client.v2.question.request.list({ location: { directory: options.directory ?? process.cwd() } })
  if (res?.error) {
    if (!this._warnedQuestion) { this._warnedQuestion = true; options.logger?.warn?.("question endpoint unavailable (404); question cards disabled") }
    return []
  }
  return ((res.data?.data) ?? []) as QuestionRequest[]
},
async replyQuestion(sessionID, requestID, answers) {
  const res = await client.v2.session.question.reply({ sessionID, requestID, $body_answers: answers })
  if (res?.error) throw new Error(res.error?.message ?? "replyQuestion failed")
},
async commands() {
  const res = await client.v2.command.list({ location: { directory: options.directory ?? process.cwd() } })
  return (((res?.data)?.data) ?? []) as CommandRef[]
},
```

需要在 gateway 内部加一个 `_warnedQuestion` 标志（闭包变量）。

**测试追加：**
- `replyPermission`：断言 URL `.../permission/per_1/reply`、body `{"decision":"once"}`。
- `listQuestions` 404：返回 `[]`，logger.warn 被调用且仅一次。
- `commands`：断言 `location[directory]` 查询串。

**提交。** `git commit -m "feat(opencode): gateway interactive ops"`

---

## 任务 3c：gateway 事件订阅 + ping

**文件：** `src/opencode/gateway.ts`、`src/opencode/__tests__/gateway.test.ts`

**追加：**

```ts
async ping() {
  await client.v2.session.active()   // 抛错即失败
},
async *subscribeEvents(signal?: AbortSignal): AsyncIterable<OpencodeEvent> {
  const res = await client.v2.event.subscribe({ signal })
  for await (const raw of res.stream) {
    yield raw as OpencodeEvent
  }
},
```

**测试：** 用 stub fetch 返回一个 SSE 流（`data: {"type":"server.connected","data":{}}\n\n`），断言 `subscribeEvents()` 产出 `{type:"server.connected", data:{}}`。

**提交。** `git commit -m "feat(opencode): gateway events + ping"`

---

## 任务 4：把 gateway 接入 `src/index.ts`

**文件：** `src/index.ts`

**改动：**
1. 删除 `import { createOpencodeClient } from "@opencode-ai/sdk/v2"`，改为 `import { createOpencodeGateway } from "./opencode/gateway.js"`。
2. 构造：`const gateway = createOpencodeGateway({ baseUrl: config.opencode.url, username: config.opencode.username, password: config.opencode.password, directory: config.opencode.cwd, logger })`。
3. `waitForServer()` 改为 `await gateway.ping()`（重试策略不变）。
4. SSE 订阅改为：
   ```ts
   const ac = new AbortController()
   for await (const event of gateway.subscribeEvents(ac.signal)) {
     // 原有分发逻辑不变，event.sessionID 取自 eventPayload(event)?.sessionID
   }
   ```
5. `EventProcessor` / `SessionManager` 等构造时传入 `gateway` 而非 `serverUrl`。

**验证：** `bun run build`（tsc）通过；`bun run start` 在 opencode 运行时能启动并列出会话。

**提交。** `git commit -m "feat(index): wire opencode gateway"`

---

## 任务 5：迁移 `session-manager.ts`

**文件：** `src/session/session-manager.ts`、`src/session/__tests__/session-manager.test.ts`

**改动映射：**

| 原 | 新 |
|---|---|
| 构造参数 `serverUrl: string` | `opencode: OpencodeGateway` |
| `fetch(`${serverUrl}/session?directory=...`)`（exists） | `opencode.listSessions({ directory })` |
| `fetch(`${serverUrl}/session/${id}`)`（validate） | `opencode.getSession(id)`（null → 不存在） |
| `fetch(`${serverUrl}/session`, {method:POST})`（create） | `opencode.createSession({ title, directory })` |
| `fetch(`${serverUrl}/session?parentID=...`)`（children） | `opencode.children(parentId)` |

**测试：** 注入 fake gateway（含 `vi.fn()`），断言调用次数与参数；删掉 URL 匹配的 fetch mock。

**提交。** `git commit -m "refactor(session-manager): use gateway"`

---

## 任务 6：迁移 `subagent-tracker.ts`

**文件：** `src/streaming/subagent-tracker.ts`、对应测试

**改动：**
- `serverUrl` → `opencode`。
- `fetch(`${serverUrl}/session?parentID=${id}`)` → `opencode.children(id)`。
- `fetch(`${serverUrl}/session/${id}/message?limit=1`)` → `opencode.messages(id, { limit: 1, order: "desc" })`，取最后一条 assistant 的文本：消息对象现在是 `{ type: "assistant", content: [{type:"text",text}] }`，拼接所有 `content` 中 `type==="text"` 的 `text`。

**提交。** `git commit -m "refactor(subagent-tracker): use gateway + new message shape"`

---

## 任务 7：迁移 `message-handler.ts`

**文件：** `src/handler/message-handler.ts`、对应测试

**改动：**
1. 构造参数 `serverUrl` → `opencode`。
2. 发消息两处：
   - 原 `fetch(POST ${serverUrl}/session/${id}/message, {body:{parts}})` → `opencode.sendPrompt(id, { text, files })`。
   - `parts` 中的文本拼成 `text`；`FilePart`（`{type:"file", mime, url}`）→ `{ uri: url }`（图片先落盘的逻辑保留，只换字段）。
3. 4 处 `event.properties` → `eventPayload(event)`（先 import）。

**404 自愈逻辑保留：** `getSession` 返回 null → 清映射 → 重新解析 → 重试一次。

**提交。** `git commit -m "refactor(message-handler): use gateway + new prompt body"`

---

## 任务 8：迁移 `command-handler.ts`

**文件：** `src/handler/command-handler.ts`、对应测试

**改动：**
- `serverUrl` → `opencode`。
- 建会话：`opencode.createSession({ title, directory: cwd })`。
- 中止：`opencode.abort(id)`。
- 校验会话存在：`opencode.getSession(id)`（null → 不存在）。
- `/sessions` 列表：`opencode.listSessions({ directory: cwd })`。

**提交。** `git commit -m "refactor(command-handler): use gateway"`

---

## 任务 9：交互处理器 + 轮询器 + 卡片按钮 `sessionId`

**文件：** `src/handler/interactive-handler.ts`、`src/handler/interactive-poller.ts`、`src/handler/streaming-integration.ts`、对应测试

**改动：**
1. `interactive-handler`：`serverUrl` → `opencode`。`permission_reply`：
   ```ts
   const sessionId = actionValue.sessionId
   if (!sessionId) { logger.warn("permission card missing sessionId; cannot reply on v2"); return }
   await opencode.replyPermission(sessionId, requestId, reply, message)
   ```
   `question_answer` 同理 `opencode.replyQuestion(sessionId, requestId, answers)`。
2. `streaming-integration.ts`：`buildPermissionCard`/`buildQuestionCard` 的按钮 value 增加 `sessionId: action.sessionId`。
3. `interactive-poller`：`serverUrl` → `opencode`；轮询 `opencode.listPermissions()` / `opencode.listQuestions()`（question 404 → `[]`）。

**提交。** `git commit -m "refactor(interactive): use gateway + sessionId in card values"`

---

## 任务 10：迁移 `cron-service.ts` + `heartbeat.ts`

**文件：** `src/cron/cron-service.ts`、`src/cron/heartbeat.ts`、对应测试

**cron-service 改动：**
- `serverUrl` → `opencode`。
- `waitForResponse`：
  - `fetch(${serverUrl}/session/${id})` + `session.status?.type === "idle"` → `opencode.getSession(id)` 后用 `opencode.activeStatuses()` 判断（或直接用 `session.idle` 事件；此处保留轮询：`const s = await opencode.getSession(id); const active = await opencode.activeStatuses(); if (!(id in active)) return ...`）。
  - `fetch(${serverUrl}/session/${id}/message?limit=1)` → `opencode.messages(id, { limit: 1, order: "desc" })`，取 assistant 文本（`content` 数组拼接）。

**heartbeat 改动：**
- `serverUrl` → `opencode`；`fetch(${serverUrl}/session/status)` → `opencode.ping()`。

**提交。** `git commit -m "refactor(cron): use gateway"`

---

## 任务 11：`session-observer.ts` 事件适配

**文件：** `src/streaming/session-observer.ts`、对应测试

**改动：** 1 处 `event.properties` → `eventPayload(event)`。

**提交。** `git commit -m "refactor(session-observer): use eventPayload"`

---

## 任务 12：飞书扫码建应用 `src/cli/feishu-onboard.ts`

**文件：** `src/cli/feishu-onboard.ts`、`src/cli/__tests__/feishu-onboard.test.ts`

**常量：**
```ts
const ACCOUNTS_URLS = { feishu: "https://accounts.feishu.cn", lark: "https://accounts.larksuite.com" }
const REGISTRATION_PATH = "/oauth/v1/app/registration"
const OPEN_URLS = { feishu: "https://open.feishu.cn", lark: "https://open.larksuite.com" }
```

**接口：**
```ts
export interface OnboardResult { appId: string; appSecret: string; domain: "feishu" | "lark"; openId?: string; botName?: string }
export async function qrRegister(opts?: { domain?: "feishu"|"lark"; timeoutSeconds?: number; onQrUrl?: (url: string) => void; fetch?: typeof fetch }): Promise<OnboardResult | null>
```

**流程（移植 Hermes `_post_registration` / `_init_registration` / `_begin_registration` / `_poll_registration`）：**
1. `POST {accountsUrl}/oauth/v1/app/registration`，`Content-Type: application/x-www-form-urlencoded`，body `action=init`。
   - 解析 JSON；若 `supported_auth_methods` 不含 `client_secret` → 抛错（或返回 null）。
2. `action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id` → `{ device_code, verification_uri_complete, user_code, interval, expire_in }`。
3. 调 `opts.onQrUrl?.(verification_uri_complete)`；默认用 `qrcode-terminal` 渲染，失败降级打印 URL。
4. 轮询：每 `interval` 秒 `action=poll&device_code=...&tp=ob_app`。
   - 200 且有 `client_id`/`client_secret` → 完成。
   - `user_info.tenant_brand === "lark"` → 切换 `accountsUrl` 到 lark，继续。
   - 错误体 `error === "access_denied" | "expired_token"` → 返回 null。
   - `authorization_pending`（含其它）→ 继续。
   - **关键：轮询的「待授权」是 4xx，必须 `await res.json()` 解析错误体，不能只看 status。**
5. 拿到凭据后 best-effort：`tenant_access_token` → `/open-apis/bot/v3/info` 取 `botName`（失败忽略）。
6. 总超时 `Math.min(expire_in, timeoutSeconds ?? 600) * 1000`。

**测试用例（mock fetch）：**
- init 不支持 `client_secret` → null/抛错
- begin → 轮询一次成功
- `access_denied` → null
- 超时 → null
- lark 域自动切换（第一次 poll 返回 `tenant_brand: "lark"`）
- 4xx 响应体解析（status 400 + body `{error:"authorization_pending"}` → 继续）

**提交。** `git commit -m "feat(cli): feishu qr onboarding (Hermes port)"`

---

## 任务 13：向导接入 + 二维码渲染

**文件：** `src/cli/setup-wizard.ts`

**Step 1：Step 1 二选一。**
```
Step 1/3: Feishu Credentials
  1. 扫码自动创建应用（推荐）
  2. 手动输入 App ID / App Secret
```
- 非 TTY（`process.stdin.isTTY !== true`）→ 直接手动输入。
- 选 1 → `qrRegister({ onQrUrl })`；成功 → 用返回的 `appId/appSecret`；失败/超时 → 提示并回退手动。
- 选 2 → 现有行为。

**Step 2：Step 2 探活改为** `gateway.ping()`（带鉴权的 `/api/session/active`），替代 `fetch(serverUrl)`。

**Step 3：写入 `.env.<appId>`：**
```
OPENCODE_SERVER_URL=http://127.0.0.1:5096
OPENCODE_SERVER_PASSWORD=<password>
```

**二维码渲染：**
```ts
import qrcode from "qrcode-terminal"
try { qrcode.generate(url, { small: true }) } catch { console.log(url) }
```
失败降级打印 URL 原文。

**提交。** `git commit -m "feat(wizard): qr onboarding + v2 connectivity check"`

---

## 任务 14：文档更新

**文件：** `README.md`、`README.zh-CN.md`、`AGENTS.md`

- v2 接入说明、Basic 鉴权配置、`OPENCODE_SERVER_PASSWORD`。
- 扫码流程说明。
- 已知限制：question 接口在 v2.0.29 不可用，提问卡片降级。

**提交。** `git commit -m "docs: v2 + feishu qr onboarding"`

---

## 任务 15：端到端真机验证

1. `bun run build` 通过。
2. `bun run test:run` 全绿。
3. 启动 `opencode serve --port 5096`，设置 `OPENCODE_SERVER_PASSWORD`，`bun run start`，确认列出本机会话。
4. 飞书发一条文本 → TUI 收到 → 回复流式卡片。
5. 权限卡片可点击。
6. 扫码流程真机跑一次（可选，需飞书 App 创建权限）。

---

## 验收标准

1. `bun run start` 连接 `http://127.0.0.1:5096`（Basic 鉴权），日志显示连接成功并列出本机会话。
2. 飞书发文本 → opencode 收到 → 流式卡片回复。
3. 权限卡片可点击并生效。
4. 全新环境 `init` → 扫码 → 自动写 `.env.<appId>` 并启动。
5. `bun run test:run` 全部通过。
6. 未设置 `OPENCODE_SERVER_PASSWORD` 时启动有清晰指引而非堆栈。

---

## 风险与未决

| 风险 | 应对 |
|---|---|
| `files[].uri` 形式未验证 | 真机逐类型验证；失败时回退纯文本 |
| `session.active` 的 `type` 是 `running`（openapi 枚举过时） | gateway 判活只看「是否在 map 里」 |
| SDK 4xx 不抛异常 | gateway 统一检查 `res.error` |
| 扫码创建的应用可能仍需后台确认长连接 | `PersonalAgent` 预设；README 排查步骤 |
| 现有测试大量依赖 URL 匹配的 fetch mock | 分模块小步替换，逐个跑 |
| 扫码会真实创建飞书应用 | 仅用户主动选择时调用；失败不写残余配置 |
