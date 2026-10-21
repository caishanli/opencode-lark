/**
 * Supervises the opencode server process.
 *
 * The bridge starts the server when it is needed and stops it when it has
 * been idle for a while: an idle server holds several hundred megabytes,
 * and the sessions live in the database, so nothing is lost by stopping it.
 *
 * The server is started detached (its own process group), so it survives a
 * restart of the bridge. Its pid is kept in a file, so the next process
 * adopts the running server instead of starting a second one.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Logger } from "../utils/logger.js"
import type { OpencodeGateway } from "./gateway.js"

export interface ServerSupervisorOptions {
  /** The executable that starts the server. */
  command: string
  /** Its arguments. */
  args: string[]
  /** Where the pid of the running server is remembered. */
  pidFile?: string
  /** How long the server may sit idle before it is stopped (ms). 0 = never. */
  idleTimeoutMs: number
  /** How often the idle state is checked (ms). */
  checkIntervalMs?: number
  /** How long to wait for the server to answer after starting it (ms). */
  readyTimeoutMs?: number
  opencode: OpencodeGateway
  logger: Logger
  /** Starts the server process — injected in tests. */
  spawnProcess?: (command: string, args: string[]) => SpawnedProcess
}

/** The part of a child process the supervisor uses. */
export interface SpawnedProcess {
  pid?: number
  unref?: () => void
  on?: (event: string, cb: (...args: unknown[]) => void) => void
}

export interface ServerSupervisor {
  /** Start the server if it is not running and wait until it answers. */
  ensureRunning(): Promise<boolean>
  /** Stop the server. */
  stop(): Promise<void>
  /** True while the server answers. */
  isRunning(): Promise<boolean>
  /** Resolves once the server is up (immediately if it already is). */
  whenRunning(): Promise<void>
  /** True when the server was stopped on purpose (it is not a failure). */
  isStoppedOnPurpose(): boolean
  /** Start watching for an idle server. */
  startIdleWatch(): void
  stopIdleWatch(): void
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createServerSupervisor(options: ServerSupervisorOptions): ServerSupervisor {
  const { opencode, logger } = options
  const checkIntervalMs = options.checkIntervalMs ?? 60_000
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000

  let child: ChildProcess | null = null
  let starting: Promise<boolean> | null = null
  let stoppedOnPurpose = false
  /** When the server was last seen without any work in flight. */
  let idleSince: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const waiters: Array<() => void> = []

  const resolveWaiters = (): void => {
    const pending = waiters.splice(0)
    for (const resolve of pending) resolve()
  }

  const ping = async (): Promise<boolean> => {
    try {
      await opencode.ping()
      return true
    } catch {
      return false
    }
  }

  const readPid = (): number | null => {
    if (!options.pidFile || !existsSync(options.pidFile)) return null
    try {
      const pid = Number(readFileSync(options.pidFile, "utf-8").trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  const writePid = (pid: number): void => {
    if (!options.pidFile) return
    try {
      writeFileSync(options.pidFile, String(pid))
    } catch (err) {
      logger.warn(`Could not remember the server pid: ${err}`)
    }
  }

  /**
   * The pid of a server that is already running (started by hand or by an
   * earlier run of the bridge). Without it the bridge could not stop the
   * server once it goes idle.
   */
  const findServerPid = (): number | null => {
    const portIndex = options.args.indexOf("--port")
    const port = portIndex >= 0 ? options.args[portIndex + 1] : undefined
    if (!port) return null
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue
        const pid = Number(entry)
        if (pid === process.pid) continue
        let cmdline: string
        try {
          cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8").replace(/\0/g, " ")
        } catch {
          continue
        }
        if (!cmdline.includes("serve")) continue
        if (!cmdline.includes(port)) continue
        // The bridge itself must never be mistaken for the server.
        if (cmdline.includes("opencode-lark")) continue
        return pid
      }
    } catch {
      // /proc is not readable — the bridge just cannot adopt the server.
    }
    return null
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Where to look for the server binary. A systemd service does not have the
   * login shell's PATH, so `opencode` (which lives in ~/.opencode/bin) is
   * not found there.
   */
  const resolveCommand = (command: string): string | null => {
    if (command.includes("/")) {
      return existsSync(command) ? command : null
    }
    const dirs = [
      ...(process.env.PATH ?? "").split(":").filter(Boolean),
      join(homedir(), ".opencode", "bin"),
      join(homedir(), ".bun", "bin"),
      join(homedir(), ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
    ]
    for (const dir of dirs) {
      const candidate = join(dir, command)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const startServer = async (): Promise<boolean> => {
    // A test may inject its own spawn — then the binary does not have to
    // exist, but it is still resolved when it does.
    const resolved = resolveCommand(options.command)
    const binary = resolved ?? (options.spawnProcess ? options.command : null)
    if (!binary) {
      logger.error(
        `Could not find "${options.command}" — it is not in PATH and not in ` +
          `~/.opencode/bin, ~/.bun/bin or ~/.local/bin. Set the full path in ` +
          `opencode.server.command.`,
      )
      return false
    }
    logger.info(`Starting the opencode server: ${binary} ${options.args.join(" ")}`)
    let proc: SpawnedProcess
    let spawnError: unknown = null
    try {
      proc = options.spawnProcess
        ? options.spawnProcess(binary, options.args)
        : spawn(binary, options.args, {
            // Its own process group: the server outlives the bridge.
            detached: true,
            stdio: "ignore",
          })
    } catch (err) {
      logger.error(`Could not start the opencode server: ${err}`)
      return false
    }
    proc.on?.("error", (err) => {
      spawnError = err
      logger.error(`The opencode server could not be started: ${err}`)
    })
    proc.unref?.()
    child = proc as ChildProcess
    if (proc.pid) writePid(proc.pid)

    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      await delay(200)
      // A failed spawn must not wait for the whole timeout.
      if (spawnError) return false
      if (await ping()) {
        logger.info("The opencode server is up")
        idleSince = Date.now()
        resolveWaiters()
        return true
      }
    }
    logger.warn("The opencode server did not answer in time")
    return false
  }

  const ensureRunning = async (): Promise<boolean> => {
    stoppedOnPurpose = false
    if (await ping()) {
      // The server is already up — adopt it, so it can be stopped later.
      if (!readPid()) {
        const pid = findServerPid()
        if (pid) {
          logger.info(`Adopting the running opencode server (pid ${pid})`)
          writePid(pid)
        }
      }
      idleSince = Date.now()
      resolveWaiters()
      return true
    }
    // One start at a time — a burst of messages must not spawn two servers.
    if (!starting) {
      starting = startServer().finally(() => {
        starting = null
      })
    }
    return starting
  }

  const stop = async (): Promise<void> => {
    stoppedOnPurpose = true
    const pid = readPid() ?? child?.pid ?? null
    if (!pid || !isAlive(pid)) {
      logger.info("There is no opencode server to stop")
      if (options.pidFile) rmSync(options.pidFile, { force: true })
      child = null
      return
    }
    logger.info(`Stopping the opencode server (pid ${pid})`)
    try {
      process.kill(pid, "SIGTERM")
    } catch (err) {
      logger.warn(`Could not stop the opencode server: ${err}`)
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && isAlive(pid)) {
      await delay(200)
    }
    if (isAlive(pid)) {
      logger.warn("The opencode server did not stop — killing it")
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // it is gone
      }
    }
    if (options.pidFile) rmSync(options.pidFile, { force: true })
    child = null
    idleSince = null
  }

  /** True while the server has no work in flight. */
  const isIdle = async (): Promise<boolean> => {
    try {
      const active = await opencode.activeStatuses()
      return Object.keys(active).length === 0
    } catch {
      // The server does not answer — it is down, not busy.
      return true
    }
  }

  const tick = async (): Promise<void> => {
    if (options.idleTimeoutMs <= 0) return
    if (!(await ping())) {
      // The server is down (stopped on purpose, or it died).
      idleSince = null
      return
    }
    if (!(await isIdle())) {
      idleSince = null
      return
    }
    if (idleSince === null) {
      idleSince = Date.now()
      logger.info(
        `The opencode server is idle — it will be stopped in ${Math.round(options.idleTimeoutMs / 60_000)} minutes`,
      )
      return
    }
    const idleMs = Date.now() - idleSince
    if (idleMs >= options.idleTimeoutMs) {
      logger.info(
        `The opencode server has been idle for ${Math.round(idleMs / 60_000)} minutes — stopping it`,
      )
      await stop()
    }
  }

  return {
    ensureRunning,
    stop,
    isRunning: ping,
    async whenRunning() {
      if (await ping()) return
      await new Promise<void>((resolve) => waiters.push(resolve))
    },
    isStoppedOnPurpose: () => stoppedOnPurpose,
    startIdleWatch() {
      if (timer) return
      timer = setInterval(() => {
        void tick().catch((err) => logger.warn(`The idle watch failed: ${err}`))
      }, checkIntervalMs)
      logger.info(
        `Idle watch started (check every ${Math.round(checkIntervalMs / 1000)}s, stop after ${Math.round(options.idleTimeoutMs / 60_000)} minutes of inactivity)`,
      )
    },
    stopIdleWatch() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
