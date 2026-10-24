import { describe, it, expect, vi } from "vitest"
import { createOpencodeGateway } from "../gateway.js"

function makeFetch(body: unknown, status = 200) {
  return vi.fn(async (req: Request) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }))
}

function sseFetch(frames: string) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(frames))
      controller.close()
    },
  })
  return vi.fn(async () => new Response(stream, {
    status: 200, headers: { "content-type": "text/event-stream" },
  }))
}

describe("gateway: session ops", () => {
  it("listSessions uses /api prefix + auth + unwraps", async () => {
    const fetchImpl = makeFetch({ data: [{ id: "s1", title: "t" }], cursor: null })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", username: "opencode", fetch: fetchImpl as any })
    const res = await gw.listSessions({ directory: "/tmp" })
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session?directory=%2Ftmp")
    expect(req.headers.get("authorization")).toBe("Basic " + btoa("opencode:pw"))
    expect(res).toEqual([{ id: "s1", title: "t" }])
  })

  it("children query string contains parentID=", async () => {
    const fetchImpl = makeFetch({ data: { data: [], cursor: null } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.children("ses_parent")
    expect((fetchImpl.mock.calls[0][0] as Request).url).toContain("parentID=ses_parent")
  })

  it("getSession returns null on 404", async () => {
    const fetchImpl = makeFetch({ error: "SessionNotFoundError" }, 404)
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    expect(await gw.getSession("ses_x")).toBeNull()
  })

  it("activeStatuses unwraps .data.data", async () => {
    const fetchImpl = makeFetch({ data: { "ses_a": { type: "running" } } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    expect(await gw.activeStatuses()).toEqual({ "ses_a": { type: "running" } })
  })

  it("sendPrompt posts {text, files} body", async () => {
    const fetchImpl = makeFetch({ data: { id: "m1" } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.sendPrompt("ses_1", { text: "hi", files: [{ uri: "file:///tmp/a.png", name: "a.png" }] }, { delivery: "queue" })
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session/ses_1/prompt")
    expect(req.method).toBe("POST")
    const body = await req.text()
    expect(JSON.parse(body)).toEqual({ text: "hi", files: [{ uri: "file:///tmp/a.png", name: "a.png" }], delivery: "queue" })
  })

  it("compactSession posts an object body (server 400s without one)", async () => {
    // The generated SDK wrapper declares only { sessionID }, but the server
    // requires a JSON body: without one it answers
    // 400 {"_tag":"InvalidRequestError","message":"Expected object"}.
    let sent = ""
    const fetchImpl = vi.fn(async (req: Request) => {
      sent = await req.text()
      if (!sent) {
        return new Response(JSON.stringify({ _tag: "InvalidRequestError", message: "Expected object", kind: "Payload" }), {
          status: 400, headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: { type: "compaction" } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await expect(gw.compactSession("ses_1")).resolves.toBeUndefined()
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session/ses_1/compact")
    expect(req.method).toBe("POST")
    expect(JSON.parse(sent)).toEqual({})
  })

  it("messages passes type via $query_type", async () => {
    const fetchImpl = makeFetch({ data: [{ id: "m1", type: "assistant" }], cursor: null })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    const res = await gw.messages("ses_1", { limit: 2, order: "desc", type: "assistant" })
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toContain("type=assistant")
    expect(req.url).toContain("limit=2")
    expect(res).toEqual([{ id: "m1", type: "assistant" }])
  })
})

describe("gateway: interactive", () => {
  it("replyPermission posts {decision}", async () => {
    const fetchImpl = makeFetch({ data: {} })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.replyPermission("ses_1", "per_1", "once")
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session/ses_1/permission/per_1/reply")
    expect(JSON.parse(await req.text())).toEqual({ decision: "once" })
  })

  it("listQuestions returns [] and warns once on 404", async () => {
    const warn = vi.fn()
    const fetchImpl = makeFetch({ error: "NotFoundError" }, 404)
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", logger: { warn }, fetch: fetchImpl as any })
    expect(await gw.listQuestions()).toEqual([])
    expect(await gw.listQuestions()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("commands unwraps location.data", async () => {
    const fetchImpl = makeFetch({ location: { directory: "/tmp" }, data: [{ name: "init" }] })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any, directory: "/tmp" })
    expect(await gw.commands()).toEqual([{ name: "init" }])
  })

  it("listPermissions unwraps", async () => {
    const fetchImpl = makeFetch({ location: { directory: "/tmp" }, data: [{ id: "p1", sessionID: "s", action: "bash", resources: [] }] })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any, directory: "/tmp" })
    const res = await gw.listPermissions()
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe("p1")
  })
})

describe("gateway: events + ping", () => {
  it("subscribeEvents yields parsed frames", async () => {
    const fetchImpl = sseFetch("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    const out: any[] = []
    for await (const e of gw.subscribeEvents()) { out.push(e) }
    expect(out).toEqual([{ type: "server.connected", data: {} }])
  })

  it("ping resolves on success", async () => {
    const fetchImpl = makeFetch({ data: { data: {} } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await expect(gw.ping()).resolves.toBeUndefined()
  })
})
describe("gateway: liveness/auth semantics", () => {
  it("ping() rejects when the server returns 401", async () => {
    const fetchImpl = makeFetch({ _tag: "UnauthorizedError", message: "unauthorized" }, 401)
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "wrong", fetch: fetchImpl as any })
    await expect(gw.ping()).rejects.toThrow()
  })

  it("listPermissions() throws on a 401 instead of returning []", async () => {
    const fetchImpl = makeFetch({ _tag: "UnauthorizedError", message: "unauthorized" }, 401)
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "wrong", fetch: fetchImpl as any })
    await expect(gw.listPermissions()).rejects.toThrow()
  })

  it("listQuestions() still degrades to [] on 404 but throws on 401", async () => {
    const notFound = makeFetch({ _tag: "NotFoundError", message: "nope" }, 404)
    const gw404 = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: notFound as any, logger: { warn: vi.fn() } })
    expect(await gw404.listQuestions()).toEqual([])

    const unauthorized = makeFetch({ _tag: "UnauthorizedError", message: "no" }, 401)
    const gw401 = createOpencodeGateway({ baseUrl: "http://x", password: "bad", fetch: unauthorized as any, logger: { warn: vi.fn() } })
    await expect(gw401.listQuestions()).rejects.toThrow()
  })
})

describe("gateway: createSession model selection", () => {
  it("sends the requested model in the create body", async () => {
    const fetchImpl = makeFetch({ data: { id: "ses-1" } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.createSession({
      title: "t",
      directory: "/tmp",
      model: { providerID: "command-code", id: "deepseek/deepseek-v4.1-flash" },
    })
    const body = JSON.parse(await (fetchImpl.mock.calls[0][0] as Request).text())
    expect(body.model).toEqual({ providerID: "command-code", id: "deepseek/deepseek-v4.1-flash" })
    expect(body.title).toBe("t")
  })

  it("omits model when not requested", async () => {
    const fetchImpl = makeFetch({ data: { id: "ses-1" } })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.createSession({ title: "t", directory: "/tmp" })
    const body = JSON.parse(await (fetchImpl.mock.calls[0][0] as Request).text())
    expect(body.model).toBeUndefined()
  })
})

describe("gateway: agents and model variants", () => {
  it("listAgents reads /api/agent", async () => {
    const fetchImpl = makeFetch({
      data: [
        { id: "build", name: "Build", description: "default", mode: "primary", hidden: false },
        { id: "compaction", name: "Compaction", mode: "primary", hidden: true },
      ],
    })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    const agents = await gw.listAgents()
    expect((fetchImpl.mock.calls[0][0] as Request).url).toContain("/api/agent")
    expect(agents.map((a) => a.id)).toEqual(["build", "compaction"])
    expect(agents[0].hidden).toBe(false)
  })

  it("switchAgent posts the agent to /api/session/:id/agent", async () => {
    const fetchImpl = makeFetch({ data: {} })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.switchAgent("ses-1", "plan")
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session/ses-1/agent")
    expect(req.method).toBe("POST")
    expect(JSON.parse(await req.text())).toEqual({ agent: "plan" })
  })

  it("switchModel carries the variant", async () => {
    const fetchImpl = makeFetch({ data: {} })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    await gw.switchModel("ses-1", { id: "m", providerID: "p", variant: "high" })
    const req = fetchImpl.mock.calls[0][0] as Request
    expect(req.url).toBe("http://x/api/session/ses-1/model")
    expect(JSON.parse(await req.text())).toEqual({ model: { id: "m", providerID: "p", variant: "high" } })
  })

  it("listModels keeps the variants opencode reports", async () => {
    const fetchImpl = makeFetch({
      data: [{ id: "m", providerID: "p", name: "M", variants: [{ id: "low" }, { id: "high" }] }],
    })
    const gw = createOpencodeGateway({ baseUrl: "http://x", password: "pw", fetch: fetchImpl as any })
    const models = await gw.listModels()
    expect(models[0].variants?.map((v) => v.id)).toEqual(["low", "high"])
  })
})
