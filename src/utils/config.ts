/**
 * Zod-validated config loader.
 * Loads from opencode-lark.jsonc (or opencode-feishu.jsonc for backward compat) with env var interpolation.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as z from "zod"

const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  verificationToken: z.string().optional().default(""),
  webhookPort: z.number().int().positive().default(3000),
  encryptKey: z.string().optional(),
})

const ProgressConfigSchema = z.object({
  debounceMs: z.number().int().positive().default(500),
  maxDebounceMs: z.number().int().positive().default(3000),
})


const CronJobSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  chatId: z.string(),
})

const CronConfigSchema = z.object({
  jobs: z.array(CronJobSchema),
})

const HeartbeatConfigSchema = z.object({
  intervalMs: z.number().default(60000),
  statusChatId: z.string().optional(),
})

const OpencodeServerSchema = z.object({
  /** The executable that starts the opencode server. */
  command: z.string().default("opencode"),
  /** Its arguments — derived from the url when omitted. */
  args: z.array(z.string()).optional(),
  /** How long the server may sit idle before it is stopped (ms). 0 = never.
   *  The default is 0: the server is not stopped unless you ask for it. */
  idleTimeoutMs: z.number().int().min(0).default(0),
})

const OpencodeConfigSchema = z.object({
  url: z.string().default("http://127.0.0.1:4096"),
  username: z.string().default("opencode"),
  password: z.string().default(""),
  cwd: z.string().default(""),
  /** The server process the bridge starts and stops. */
  server: OpencodeServerSchema.optional(),
})

const AppConfigSchema = z.object({
  feishu: FeishuConfigSchema,
  defaultAgent: z.string().default("build"),
  dataDir: z.string().default("./data"),
  progress: ProgressConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  messageDebounceMs: z.number().int().min(0).optional().default(10000),
  opencode: OpencodeConfigSchema.optional(),
  /**
   * Append a "[Lark] …" signature to every message that is forwarded to
   * opencode, so the agent knows the message came from Feishu (and where to
   * put the files it creates). Off by default — turn it on while developing.
   */
  larkSignature: z.boolean().optional().default(false),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type CronConfig = z.infer<typeof CronConfigSchema>
export type CronJobConfig = z.infer<typeof CronJobSchema>
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>

/** Replace ${ENV_VAR} placeholders with actual environment variable values */
function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? ""
  })
}

/** Strip JSONC comments for JSON.parse; string-aware so URLs in strings survive */
function stripJsoncComments(text: string): string {
  let result = ""
  let i = 0
  const n = text.length
  let inString = false
  let escape = false
  while (i < n) {
    const c = text[i]!
    if (inString) {
      result += c
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') { inString = true; result += c; i++; continue }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    result += c
    i++
  }
  return result
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const searchPaths = configPath
    ? [configPath]
    : [
        path.resolve("opencode-lark.jsonc"),
        path.resolve("opencode-lark.json"),
        path.resolve("opencode-feishu.jsonc"),
        path.resolve("opencode-feishu.json"),
      ]

  let rawText: string | undefined
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      rawText = fs.readFileSync(p, "utf-8")
      break
    }
  }

  // Fall back to pure env vars if no config file
  if (!rawText) {
    rawText = JSON.stringify({
      feishu: {
        appId: process.env["FEISHU_APP_ID"] ?? "",
        appSecret: process.env["FEISHU_APP_SECRET"] ?? "",
        verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"] ?? "",
        webhookPort: Number(process.env["OPENCODE_FEISHU_PORT"] ?? "3000"),
        encryptKey: process.env["FEISHU_ENCRYPT_KEY"],
      },
      defaultAgent: "build",
      dataDir: "./data",
      opencode: {
        url: process.env["OPENCODE_SERVER_URL"] ?? "http://127.0.0.1:4096",
        username: process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode",
        password: process.env["OPENCODE_SERVER_PASSWORD"] ?? "",
        cwd: process.env["OPENCODE_CWD"] ?? "",
      },
    })
  }

  const interpolated = interpolateEnvVars(rawText)
  const stripped = stripJsoncComments(interpolated)
  const parsed = JSON.parse(stripped) as unknown

  return AppConfigSchema.parse(parsed)
}
