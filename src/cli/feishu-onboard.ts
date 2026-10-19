/**
 * Feishu onboarding via QR code (device-code flow).
 *
 * Ported from Hermes' plugins/platforms/feishu/adapter.py
 * (_post_registration / _init_registration / _begin_registration / _poll_registration).
 */

import qrcode from "qrcode-terminal"

export interface OnboardResult {
  appId: string
  appSecret: string
  domain: "feishu" | "lark"
  openId?: string
  botName?: string
}

export const ACCOUNTS_URLS = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
}
export const REGISTRATION_PATH = "/oauth/v1/app/registration"
export const OPEN_URLS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
}

export interface QrRegisterOptions {
  domain?: "feishu" | "lark"
  timeoutSeconds?: number
  onQrUrl?: (url: string) => void
  fetch?: typeof fetch
  renderQr?: (url: string) => void
}

interface RegistrationResponse {
  device_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  user_code?: string
  interval?: number
  expire_in?: number
  expires_in?: number
  client_id?: string
  client_secret?: string
  user_info?: { open_id?: string; tenant_brand?: string }
  error?: string
  error_description?: string
  supported_auth_methods?: string[]
}

/** Per-request timeout, mirroring the reference implementation's 10s. */
const REQUEST_TIMEOUT_MS = 10_000
/** Appended to the verification URL before rendering, mirroring the reference implementation. */
const CLIENT_TAG = "opencode-lark"

async function postRegistration(
  fetchImpl: typeof fetch,
  accountsUrl: string,
  params: Record<string, string>,
): Promise<{ status: number; body: RegistrationResponse }> {
  const body = new URLSearchParams(params)
  // Bound each request so a hung connection can't stall onboarding forever.
  const resp = await fetchImpl(`${accountsUrl}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // The pending state is a 4xx whose body still carries JSON — always try to parse.
  let parsed: RegistrationResponse = {}
  try {
    parsed = (await resp.json()) as RegistrationResponse
  } catch {
    // ignore
  }
  return { status: resp.status, body: parsed }
}

function defaultRenderQr(url: string): void {
  try {
    qrcode.generate(url, { small: true })
  } catch {
    console.log(url)
  }
}

export async function qrRegister(opts: QrRegisterOptions = {}): Promise<OnboardResult | null> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const domain = opts.domain ?? "feishu"
  const timeoutSeconds = opts.timeoutSeconds ?? 600
  let accountsUrl = ACCOUNTS_URLS[domain]

  // 1. init
  const initRes = await postRegistration(fetchImpl, accountsUrl, { action: "init" })
  if (!initRes.body.supported_auth_methods || !initRes.body.supported_auth_methods.includes("client_secret")) {
    return null
  }

  // 2. begin
  const beginRes = await postRegistration(fetchImpl, accountsUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  })
  const begin = beginRes.body
  if (!begin.device_code || !begin.verification_uri_complete) return null

  const deviceCode = begin.device_code
  const verificationUrl =
    begin.verification_uri_complete ??
    begin.verification_uri ??
    ""
  const qrUrl =
    verificationUrl + (verificationUrl.includes("?") ? "&" : "?") + `from=${CLIENT_TAG}&tp=${CLIENT_TAG}`
  const interval = Math.max(1, begin.interval ?? 5)
  const serverExpiry = begin.expires_in ?? begin.expire_in ?? timeoutSeconds
  const expireIn = Math.min(serverExpiry, timeoutSeconds)

  // 3. render qr
  const render = opts.renderQr ?? defaultRenderQr
  if (opts.onQrUrl) opts.onQrUrl(qrUrl)
  render(qrUrl)

  // 4. poll
  const deadline = Date.now() + expireIn * 1000
  let switched = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000))

    let pollBody: RegistrationResponse
    try {
      const pollRes = await postRegistration(fetchImpl, accountsUrl, {
        action: "poll",
        device_code: deviceCode,
        tp: "ob_app",
      })
      pollBody = pollRes.body
    } catch {
      // Transient network/timeout error — keep polling instead of aborting onboarding.
      continue
    }
    const body = pollBody

    // Domain auto-detect. Do NOT skip this iteration: the same response may
    // already carry the credentials.
    if (body.user_info?.tenant_brand === "lark" && !switched) {
      switched = true
      accountsUrl = ACCOUNTS_URLS.lark
    }

    if (body.client_id && body.client_secret) {
      const isLark = body.user_info?.tenant_brand === "lark"
      const result: OnboardResult = {
        appId: body.client_id,
        appSecret: body.client_secret,
        domain: isLark ? "lark" : switched ? "lark" : domain,
        openId: body.user_info?.open_id,
      }
      // best-effort bot name
      try {
        const tokenResp = await fetchImpl(`${OPEN_URLS[result.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: result.appId, app_secret: result.appSecret }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const tokenData = (await tokenResp.json()) as { tenant_access_token?: string }
        if (tokenData.tenant_access_token) {
          const botResp = await fetchImpl(`${OPEN_URLS[result.domain]}/open-apis/bot/v3/info`, {
            headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          const botData = (await botResp.json()) as { bot?: { app_name?: string } }
          if (botData.bot?.app_name) result.botName = botData.bot.app_name
        }
      } catch {
        // ignore
      }
      return result
    }

    const err = body.error
    if (err === "access_denied" || err === "expired_token") return null
    // authorization_pending or others -> continue
  }

  return null
}