/**
 * Sole access point to the opencode v2 HTTP API.
 *
 * Every URL, header, query/body shape and auth detail for opencode lives
 * here. Consumers receive an OpencodeGateway and never touch fetch/URLs.
 *
 * IMPORTANT: the @opencode-ai/sdk@1.19.3 .d.ts does NOT match the v2.0.29
 * server. Call signatures below follow stub-fetch verification (see plan
 * §5.1 matrix), not the SDK's declared types. Undeclared params are
 * silently dropped by the SDK, so we use the dollar-body and dollar-query escape hatches.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"

export interface OpencodeGatewayOptions {
  baseUrl: string
  username?: string
  password: string
  directory?: string
  logger?: { warn(msg: string, ...args: unknown[]): void }
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
  outcome?: string
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

export interface QuestionOption { label: string; description?: string; value?: string }
export interface QuestionInfo {
  question: string
  header: string
  options: Array<{ label: string; description?: string; value?: string }>
  multiple?: boolean
  custom?: boolean
}
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

export interface CommandRef { name: string; description?: string }

/** A model as opencode reports it. */
export interface ModelInfo {
  id: string
  providerID: string
  name: string
  /** The context window in tokens. */
  context?: number
  enabled?: boolean
}

export type OpencodeEvent = {
  id?: string
  type: string
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
}

export interface OpencodeGateway {
  listSessions(query?: { directory?: string; parentID?: string; limit?: number; search?: string }): Promise<SessionRef[]>
  getSession(sessionID: string): Promise<SessionRef | null>
  createSession(body?: { title?: string; parentID?: string; agent?: string; directory?: string; model?: { providerID: string; id: string; variant?: string } }): Promise<SessionRef>
  children(parentSessionID: string): Promise<SessionRef[]>
  messages(sessionID: string, query?: { limit?: number; order?: "asc" | "desc"; type?: string }): Promise<any[]>
  sendPrompt(sessionID: string, input: PromptInput, opts?: { delivery?: "steer" | "queue" }): Promise<void>
  /** Run one of opencode's own commands (the ones listed by /api/command). */
  sendCommand(sessionID: string, input: { command: string; arguments?: string }): Promise<void>
  /** The models available for this project. */
  listModels(): Promise<ModelInfo[]>
  /** Change the model of a session. */
  switchModel(sessionID: string, model: { id: string; providerID: string }): Promise<void>
  abort(sessionID: string): Promise<void>
  activeStatuses(): Promise<Record<string, { type: string }>>

  listPermissions(): Promise<PermissionRequest[]>
  replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject", message?: string): Promise<void>
  listQuestions(): Promise<QuestionRequest[]>
  replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<void>

  commands(): Promise<CommandRef[]>

  subscribeEvents(signal?: AbortSignal): AsyncIterable<OpencodeEvent>

  ping(): Promise<void>
}

export function createOpencodeGateway(options: OpencodeGatewayOptions): OpencodeGateway {
  const client = createOpencodeClient({
    baseUrl: options.baseUrl,
    headers: { Authorization: "Basic " + btoa(`${options.username ?? "opencode"}:${options.password}`) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }) as any

  const dir = () => options.directory ?? process.cwd()
  let warnedQuestion = false

  const httpStatus = (res: any): number | undefined => res?.response?.status

  const errorText = (res: any, label: string): string => {
    const tag = res?.error?._tag ?? res?.error?.name
    const msg = res?.error?.message ?? (typeof res?.error === "string" ? res.error : undefined)
    const status = httpStatus(res)
    const parts = [label, status ? `HTTP ${status}` : undefined, tag, msg].filter(Boolean)
    return parts.join(": ")
  }

  const unwrap = (res: any): any => {
    if (!res) return null
    if (res.error) return null
    const body = res.data
    if (body && typeof body === "object" && "data" in body) return body.data
    return body ?? null
  }

  const throwIfError = (res: any, label: string) => {
    if (res?.error) throw new Error(res.error?.message ?? `${label} failed`)
  }

  const gw: OpencodeGateway = {
    async listSessions(query = {}) {
      const res = await client.v2.session.list({
        directory: query.directory ?? options.directory,
        limit: query.limit,
        search: query.search,
        $query_parentID: query.parentID,
      })
      const data = unwrap(res)
      return Array.isArray(data) ? (data as SessionRef[]) : []
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
        model: body.model,
        $body_title: body.title,
        $body_agent: body.agent,
        $body_parentID: body.parentID,
      })
      throwIfError(res, "createSession")
      return unwrap(res) as SessionRef
    },
    async messages(sessionID, query = {}) {
      const res = await client.v2.session.messages({
        sessionID,
        limit: query.limit,
        order: query.order,
        $query_type: query.type,
      })
      const body = res?.data ?? {}
      return Array.isArray(body.data) ? body.data : []
    },
    async sendPrompt(sessionID, input, opts = {}) {
      const res = await client.v2.session.prompt({
        sessionID,
        $body_text: input.text,
        $body_files: input.files,
        $body_agents: input.agents,
        $body_delivery: opts.delivery,
      })
      throwIfError(res, "sendPrompt")
    },
    async sendCommand(sessionID, input) {
      const res = await client.v2.session.command({
        sessionID,
        $body_command: input.command,
        $body_arguments: input.arguments,
      })
      throwIfError(res, "sendCommand")
    },
    async listModels() {
      const res = await client.v2.model.list({ location: { directory: dir() } })
      const body = unwrap(res)
      if (!Array.isArray(body)) return []
      return body.map((m: any) => ({
        id: String(m.id ?? ""),
        providerID: String(m.providerID ?? ""),
        name: String(m.name ?? m.id ?? ""),
        context: typeof m.limit?.context === "number" ? m.limit.context : undefined,
        enabled: m.enabled !== false,
      })) as ModelInfo[]
    },
    async switchModel(sessionID, model) {
      const res = await client.v2.session.switchModel({
        sessionID,
        model: { id: model.id, providerID: model.providerID },
      })
      throwIfError(res, "switchModel")
    },
    async abort(sessionID) {
      await client.v2.session.interrupt({ sessionID })
    },
    async activeStatuses() {
      const res = await client.v2.session.active()
      const data = unwrap(res)
      return (data && typeof data === "object" ? data : {}) as Record<string, { type: string }>
    },

    async listPermissions() {
      const res = await client.v2.permission.request.list({ location: { directory: dir() } })
      if (res?.error) throw new Error(errorText(res, "listPermissions failed"))
      const body = res?.data ?? {}
      return Array.isArray(body.data) ? (body.data as PermissionRequest[]) : []
    },
    async replyPermission(sessionID, requestID, reply, message) {
      const res = await client.v2.session.permission.reply({
        sessionID,
        requestID,
        $body_decision: reply,
        $body_message: message,
      })
      throwIfError(res, "replyPermission")
    },
    async listQuestions() {
      const res = await client.v2.question.request.list({ location: { directory: dir() } })
      if (res?.error) {
        // 404 => this server has no question endpoint; degrade silently.
        // Anything else (401/500/...) is a real failure callers must see.
        if (httpStatus(res) !== 404) throw new Error(errorText(res, "listQuestions failed"))
        if (!warnedQuestion) {
          warnedQuestion = true
          options.logger?.warn?.("question endpoint unavailable (404); question cards disabled")
        }
        return []
      }
      const body = res?.data ?? {}
      return Array.isArray(body.data) ? (body.data as QuestionRequest[]) : []
    },
    async replyQuestion(sessionID, requestID, answers) {
      const res = await client.v2.session.question.reply({
        sessionID,
        requestID,
        $body_answers: answers,
      })
      throwIfError(res, "replyQuestion")
    },

    async commands() {
      const res = await client.v2.command.list({ location: { directory: dir() } })
      const body = res?.data ?? {}
      return Array.isArray(body.data) ? (body.data as CommandRef[]) : []
    },

    async *subscribeEvents(signal?: AbortSignal) {
      const res = await client.v2.event.subscribe({ signal })
      for await (const raw of res.stream) {
        yield raw as OpencodeEvent
      }
    },

    async ping() {
      const res = await client.v2.session.active()
      if (res?.error) {
        // The SDK does not throw on 4xx, so surface auth/health failures explicitly.
        // 401 => wrong or missing OPENCODE_SERVER_PASSWORD (callers must not retry).
        const status = httpStatus(res)
        const hint = status === 401 ? " (check OPENCODE_SERVER_PASSWORD)" : ""
        throw new Error(`${errorText(res, "opencode health check failed")}${hint}`)
      }
    },
  }

  return gw
}