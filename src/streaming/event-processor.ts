// ═══════════════════════════════════════════
// SSE Event Processor
// Parses raw opencode SSE events into typed actions.
// ═══════════════════════════════════════════

import { eventPayload } from "../opencode/events.js"

// ---------------------------------------------------------------------------
// Output action types
// ---------------------------------------------------------------------------

export interface TextDelta {
  readonly type: "TextDelta"
  readonly sessionId: string
  readonly text: string
}


export interface ToolStateChange {
  readonly type: "ToolStateChange"
  readonly sessionId: string
  readonly toolName: string
  readonly state: string
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly error?: string
  readonly title?: string
}

export interface SubtaskDiscovered {
  readonly type: "SubtaskDiscovered"
  readonly sessionId: string
  readonly prompt: string
  readonly description: string
  readonly agent: string
}


export interface SessionIdle {
  readonly type: "SessionIdle"
  readonly sessionId: string
}

export interface QuestionAsked {
  readonly type: "QuestionAsked"
  readonly sessionId: string
  readonly requestId: string
  readonly questions: ReadonlyArray<{
    question: string
    header: string
    options: ReadonlyArray<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

export interface PermissionRequested {
  readonly type: "PermissionRequested"
  readonly sessionId: string
  readonly requestId: string
  readonly permissionType: string
  readonly title: string
  readonly metadata: Record<string, unknown>
}

export type ProcessedAction =
  | TextDelta
  | ToolStateChange
  | SubtaskDiscovered
  | SessionIdle
  | QuestionAsked
  | PermissionRequested

// ---------------------------------------------------------------------------
// Input event shapes (from actual opencode SSE stream)
// ---------------------------------------------------------------------------

interface MessagePartUpdatedEvent {
  type: "message.part.updated"
  properties: {
    part: {
      id?: string
      sessionID: string
      messageID: string
      type: string

      text?: string

      tool?: string
      state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string }

      prompt?: string
      description?: string
      agent?: string
    }
    delta?: string
  }
}

// Streaming text delta — separate event type from message.part.updated
interface MessagePartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

interface SessionStatusEvent {
  type: "session.status"
  properties: {
    sessionID: string
    status: { type: string }
  }
}

interface SessionIdleEvent {
  type: "session.idle"
  properties: {
    sessionID: string
  }
}

interface QuestionAskedEvent {
  type: "question.asked"
  properties: {
    id: string
    sessionID: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiple?: boolean
      custom?: boolean
    }>
    tool?: {
      messageID: string
      callID: string
    }
  }
}

interface PermissionAskedEvent {
  type: "permission.asked"
  properties: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    always: string[]
    tool?: {
      messageID: string
      callID: string
    }
  }
}

type KnownEvent =
  | MessagePartUpdatedEvent
  | MessagePartDeltaEvent
  | SessionStatusEvent
  | SessionIdleEvent
  | QuestionAskedEvent
  | PermissionAskedEvent
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object"
}

function hasType(v: unknown): v is { type: string } {
  return isObject(v) && typeof v.type === "string"
}

const KNOWN_TYPES = new Set([
  "message.part.updated",
  "message.part.delta",
  // v2.0.29 real names (verified against the live server binary + live stream)
  "session.text.delta",
  "session.text.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.tool.progress",
  // SDK-declared names kept for forward/backward compatibility
  "session.next.text.delta",
  "session.status",
  "session.idle",
  "question.asked",
  "question.v2.asked",
  "permission.asked",
  "permission.v2.asked",
])

function isKnownEvent(v: unknown): v is { type: string } {
  if (!hasType(v)) return false
  return KNOWN_TYPES.has(v.type)
}

// ---------------------------------------------------------------------------
// EventProcessor
// ---------------------------------------------------------------------------

export interface EventProcessorOptions {
  ownedSessions: Set<string>
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

export class EventProcessor {
  private readonly ownedSessions: Set<string>
  private readonly reasoningPartIds = new Set<string>()
  private readonly toolNamesByCallId = new Map<string, string>()
  private readonly logger?: { warn(msg: string, ...args: unknown[]): void }

  constructor(options: EventProcessorOptions) {
    this.ownedSessions = options.ownedSessions
    this.logger = options.logger
  }

  processEvent(raw: unknown): ProcessedAction | null {
    try {
      if (!isKnownEvent(raw)) return null

      switch (raw.type) {
        case "message.part.updated":
          return this.processMessagePartUpdated(raw)
        case "message.part.delta":
          return this.processMessagePartDelta(raw)
        case "session.text.delta":
        case "session.next.text.delta":
          return this.processSessionTextDelta(raw)
        case "session.text.ended":
          return null
        case "session.tool.called":
          return this.processSessionToolCalled(raw)
        case "session.tool.success":
        case "session.tool.failed":
          return this.processSessionToolFinished(raw)
        case "session.tool.progress":
          return null
        case "session.status":
          return this.processSessionStatus(raw)
        case "session.idle":
          return this.processSessionIdle(raw)
        case "question.asked":
        case "question.v2.asked":
          return this.processQuestionAsked(raw)
        case "permission.asked":
        case "permission.v2.asked":
          return this.processPermissionAsked(raw)
        default:
          return null
      }
    } catch (err) {
      const eventType = (raw as Record<string, unknown>)?.type ?? "unknown"
      this.logger?.warn(`Error processing ${eventType} event: ${err}`)
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Private handlers
  // -------------------------------------------------------------------------

  private processMessagePartUpdated(
    event: any,
  ): ProcessedAction | null {
    const props = eventPayload(event)
    if (!props) return null
    const { part, delta } = props as { part?: unknown; delta?: string }
    if (!part || !isObject(part)) return null

    const sessionId = (part as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const partType = (part as Record<string, unknown>).type
    if (typeof partType !== "string") return null

    // Track reasoning part IDs so message.part.delta events can be filtered
    const partId = (part as Record<string, unknown>).id
    if (partType === "reasoning" && typeof partId === "string") {
      this.reasoningPartIds.add(partId)
    }

    switch (partType) {
      case "text":
        return this.processTextPart(sessionId, delta)
      case "reasoning":
        return this.processReasoningPart(sessionId, delta)
      case "tool":
        return this.processToolPart(sessionId, part as any)
      case "subtask":
        return this.processSubtaskPart(sessionId, part as any)
      default:
        return null
    }
  }

  private processMessagePartDelta(
    event: any,
  ): TextDelta | null {
    const props = eventPayload(event)
    if (!props) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const field = (props as Record<string, unknown>).field
    if (field !== "text") return null

    const delta = (props as Record<string, unknown>).delta
    if (typeof delta !== "string" || delta.length === 0) return null

    // Check if this delta belongs to a reasoning part
    const partID = (props as Record<string, unknown>).partID
    if (typeof partID === "string" && this.reasoningPartIds.has(partID)) {
      return null
    }

    return { type: "TextDelta", sessionId, text: delta }
  }

  private processSessionTextDelta(event: any): TextDelta | null {
    const props = eventPayload(event)
    if (!props) return null
    const sessionId = props.sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null
    const delta = props.delta
    if (typeof delta !== "string" || delta.length === 0) return null
    return { type: "TextDelta", sessionId, text: delta }
  }

  private processSessionToolCalled(event: any): ToolStateChange | null {
    const props = eventPayload(event)
    if (!props) return null
    const sessionId = props.sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null
    const callID = props.callID
    const toolName = props.tool
    if (typeof toolName !== "string") return null
    if (typeof callID === "string") this.toolNamesByCallId.set(callID, toolName)
    const input = props.input
    return {
      type: "ToolStateChange",
      sessionId,
      toolName,
      state: "running",
      ...(isObject(input) ? { input: input as Record<string, unknown> } : {}),
    }
  }

  private processSessionToolFinished(event: any): ToolStateChange | null {
    const props = eventPayload(event)
    if (!props) return null
    const sessionId = props.sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null
    const callID = props.callID
    const toolName =
      (typeof callID === "string" ? this.toolNamesByCallId.get(callID) : undefined) ?? "tool"
    const failed = (event as { type?: string })?.type === "session.tool.failed"
    const error = props.error
    return {
      type: "ToolStateChange",
      sessionId,
      toolName,
      state: failed ? "error" : "completed",
      ...(failed && typeof error === "string" ? { error } : {}),
    }
  }

  private processTextPart(
    sessionId: string,
    delta: string | undefined,
  ): TextDelta | null {
    if (typeof delta !== "string" || delta.length === 0) return null
    return { type: "TextDelta", sessionId, text: delta }
  }

  private processReasoningPart(
    _sessionId: string,
    _delta: string | undefined,
  ): null {
    return null
  }

  private processToolPart(
    sessionId: string,
    part: MessagePartUpdatedEvent["properties"]["part"],
  ): ToolStateChange | null {
    const toolName = part.tool
    const state = part.state
    if (typeof toolName !== "string" || !isObject(state)) return null
    const status = (state as Record<string, unknown>).status
    if (typeof status !== "string") return null

    const error = (state as Record<string, unknown>).error
    const title = (state as Record<string, unknown>).title
    const input = (state as Record<string, unknown>).input
    const output = (state as Record<string, unknown>).output
    const result: ToolStateChange = {
      type: "ToolStateChange",
      sessionId,
      toolName,
      state: status,
      ...(isObject(input) ? { input: input as Record<string, unknown> } : {}),
      ...(typeof output === "string" ? { output } : {}),
      ...(typeof error === "string" ? { error } : {}),
      ...(typeof title === "string" ? { title } : {}),
    }
    return result
  }

  private processSubtaskPart(
    sessionId: string,
    part: MessagePartUpdatedEvent["properties"]["part"],
  ): SubtaskDiscovered | null {
    const { prompt, description, agent } = part
    if (
      typeof prompt !== "string" ||
      typeof description !== "string" ||
      typeof agent !== "string"
    ) {
      return null
    }
    return { type: "SubtaskDiscovered", sessionId, prompt, description, agent }
  }

  private processSessionStatus(
    event: any,
  ): SessionIdle | null {
    const props = eventPayload(event)
    if (!props) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const status = props.status
    if (!isObject(status)) return null

    const statusType = (status as Record<string, unknown>).type
    if (typeof statusType !== "string") return null

    switch (statusType) {
      case "busy":
        return null
      case "idle":
        return { type: "SessionIdle", sessionId }
      default:
        return null
    }
  }

  private processSessionIdle(
    event: any,
  ): SessionIdle | null {
    const props = eventPayload(event)
    if (!props) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    return { type: "SessionIdle", sessionId }
  }

  private processQuestionAsked(
    event: any,
  ): QuestionAsked | null {
    const props = eventPayload(event)
    if (!props) return null

    const requestId = (props as Record<string, unknown>).id
    if (typeof requestId !== "string") return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null

    const questions = (props as Record<string, unknown>).questions
    if (!Array.isArray(questions) || questions.length === 0) return null

    return {
      type: "QuestionAsked",
      sessionId,
      requestId,
      questions: questions as QuestionAsked["questions"],
    }
  }

  private processPermissionAsked(
    event: any,
  ): PermissionRequested | null {
    const props = eventPayload(event)
    if (!props) return null

    const requestId = (props as Record<string, unknown>).id
    if (typeof requestId !== "string") return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null

    const permissionType = (props as Record<string, unknown>).action ?? (props as Record<string, unknown>).permission
    if (typeof permissionType !== "string") return null

    const resources = (props as Record<string, unknown>).resources ?? (props as Record<string, unknown>).patterns
    const resourceList = Array.isArray(resources) ? resources.filter((p): p is string => typeof p === "string") : []
    const title = resourceList.length > 0 ? resourceList.join(", ") : String(permissionType)

    const metadata = (props as Record<string, unknown>).metadata

    return {
      type: "PermissionRequested",
      sessionId,
      requestId,
      permissionType,
      title,
      metadata: isObject(metadata) ? metadata as Record<string, unknown> : {},
    }
  }
}
