import { describe, it, expect, vi } from "vitest"
import { qrRegister, ACCOUNTS_URLS, REGISTRATION_PATH } from "../feishu-onboard.js"

function makeFetch(responses: Array<{ status?: number; body: unknown }>) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1]
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
}

describe("qrRegister", () => {
  it("returns null when init lacks client_secret", async () => {
    const fetchImpl = makeFetch([
      { body: { supported_auth_methods: ["other"] } },
    ])
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 1 })
    expect(res).toBeNull()
  })

  it("completes on successful poll", async () => {
    const fetchImpl = makeFetch([
      { body: { supported_auth_methods: ["client_secret"] } },
      { body: { device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expire_in: 10 } },
      { body: { client_id: "cli_abc", client_secret: "sec_xyz", user_info: { open_id: "ou_1", tenant_brand: "feishu" } } },
    ])
    const onQrUrl = vi.fn()
    const res = await qrRegister({ fetch: fetchImpl as any, onQrUrl, timeoutSeconds: 10, renderQr: () => {} })
    expect(res).not.toBeNull()
    expect(res!.appId).toBe("cli_abc")
    expect(res!.appSecret).toBe("sec_xyz")
    expect(onQrUrl).toHaveBeenCalledWith("https://x/qr?from=opencode-lark&tp=opencode-lark")
  })

  it("returns null on access_denied", async () => {
    const fetchImpl = makeFetch([
      { body: { supported_auth_methods: ["client_secret"] } },
      { body: { device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expire_in: 10 } },
      { status: 400, body: { error: "access_denied" } },
    ])
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 10, renderQr: () => {} })
    expect(res).toBeNull()
  })

  it("switches to lark domain on tenant_brand lark", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ supported_auth_methods: ["client_secret"] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expire_in: 10 }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_info: { tenant_brand: "lark" } }), { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ client_id: "cli_lark", client_secret: "sec_lark", user_info: { tenant_brand: "lark" } }), { status: 200, headers: { "content-type": "application/json" } }))
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 10, renderQr: () => {} })
    expect(res).not.toBeNull()
    expect(res!.domain).toBe("lark")
    // second poll should hit lark accounts url
    const urls = fetchImpl.mock.calls.map((c: any) => c[0])
    expect(urls.some((u: string) => u.includes("accounts.larksuite.com"))).toBe(true)
  })
})

describe("qrRegister — robustness fixes (vs Hermes reference)", () => {
  it("does NOT skip credentials when the same poll response also reports tenant_brand=lark", async () => {
    // Hermes: "Domain auto-detection; fall through — this same response may carry credentials."
    const fetchImpl = makeFetch([
      { body: { supported_auth_methods: ["client_secret"] } },
      { body: { device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expires_in: 30 } },
      { body: { client_id: "cli_l", client_secret: "sec_l", user_info: { tenant_brand: "lark" } } },
    ])
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 10, renderQr: () => {} })
    expect(res).not.toBeNull()
    expect(res!.appId).toBe("cli_l")
    expect(res!.domain).toBe("lark")
    // exactly init + begin + the one poll that carried both the lark hint and the credentials
    const registrationCalls = fetchImpl.mock.calls.filter((c: any) => String(c[0]).includes("/oauth/v1/app/registration"))
    expect(registrationCalls).toHaveLength(3)
  })

  it("keeps polling through transient network errors instead of aborting", async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) return new Response(JSON.stringify({ supported_auth_methods: ["client_secret"] }), { status: 200 })
      if (call === 2) return new Response(JSON.stringify({ device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expires_in: 30 }), { status: 200 })
      if (call === 3) throw new Error("ECONNRESET")
      return new Response(JSON.stringify({ client_id: "cli_ok", client_secret: "sec_ok" }), { status: 200 })
    })
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 10, renderQr: () => {} })
    expect(res).not.toBeNull()
    expect(res!.appId).toBe("cli_ok")
  })

  it("honours expires_in returned by begin as the total timeout", async () => {
    const fetchImpl = makeFetch([
      { body: { supported_auth_methods: ["client_secret"] } },
      { body: { device_code: "dc1", verification_uri_complete: "https://x/qr", interval: 1, expires_in: 1 } },
      { body: { error: "authorization_pending" } },
    ])
    const t0 = Date.now()
    const res = await qrRegister({ fetch: fetchImpl as any, timeoutSeconds: 600, renderQr: () => {} })
    const elapsed = Date.now() - t0
    expect(res).toBeNull()
    // must give up ~1s (expires_in), not wait the 600s cap
    expect(elapsed).toBeLessThan(5000)
  })
})
