/**
 * Live progress for an `opencode upgrade`.
 *
 * The CLI hides the installer behind its own "Upgrading…" spinner, so its
 * output carries no percentage. The installer does leave a trace: it downloads
 * the release tarball into /tmp/opencode_install_<pid>/cli-<target>-<version>.tgz.
 * Poll that file and compare its size with the size the registry reports.
 */

import { readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface UpgradeProgressSample {
  /** Bytes downloaded so far. */
  bytes: number
  /** The tarball's total size, when the registry reported it. */
  total?: number
  /** 0-100, only when the total is known. */
  percent?: number
  /** The version being installed, parsed from the tarball name. */
  version?: string
  /** Bytes per second, measured between two samples (smoothed). */
  bytesPerSecond?: number
  /** Checking the version / fetching the installer, downloading, installing. */
  phase: "preparing" | "downloading" | "installing"
}

export interface UpgradeProgressOptions {
  /** Only install directories created around this time are considered. */
  startedAt: number
  /** Called on every tick with the latest state. */
  onUpdate: (sample: UpgradeProgressSample) => void
  /** Poll interval in ms (default 800). */
  intervalMs?: number
  /** The directory the installer works in (default os.tmpdir()). */
  tmpDir?: string
  /** Reads the tarball size from the registry. Injectable for tests. */
  fetchTotal?: (url: string) => Promise<number | undefined>
}

/** `cli-linux-x64-2.1.4.tgz` -> `{ target: "linux-x64", version: "2.1.4" }` */
export function parseTarballName(
  file: string,
): { target: string; version: string } | undefined {
  const match = /^cli-(.+)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.tgz$/.exec(file)
  if (!match) return undefined
  return { target: match[1]!, version: match[2]! }
}

/** The newest install directory created by this upgrade run, with its tarball. */
function findTarball(
  dir: string,
  startedAt: number,
): { file: string; size: number } | undefined {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.startsWith("opencode_install_"))
  } catch {
    return undefined
  }

  let newest: { at: number; path: string } | undefined
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      // The installer creates the directory when the download starts; a
      // leftover from an earlier upgrade must not be reported.
      if (!stat.isDirectory() || stat.mtimeMs < startedAt - 5_000) continue
      if (!newest || stat.mtimeMs > newest.at) newest = { at: stat.mtimeMs, path }
    } catch {
      // The installer removed it between readdir and stat — ignore.
    }
  }

  if (!newest) return undefined
  let files: string[]
  try {
    files = readdirSync(newest.path)
  } catch {
    return undefined
  }
  const file = files.find((name) => name.endsWith(".tgz"))
  if (!file) return undefined
  try {
    return { file, size: statSync(join(newest.path, file)).size }
  } catch {
    return undefined
  }
}

async function fetchTotalFromRegistry(url: string): Promise<number | undefined> {
  const res = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    // The download must keep reporting even when the registry is slow.
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok && res.status !== 206) return undefined
  const range = res.headers.get("content-range")
  const total = range
    ? Number(range.split("/").at(-1))
    : Number(res.headers.get("content-length"))
  return Number.isFinite(total) && total > 0 ? total : undefined
}

/** The tarball's size, from either the current or the old package scope. */
async function totalFor(
  file: string,
  fetchTotal: (url: string) => Promise<number | undefined>,
): Promise<number | undefined> {
  const parsed = parseTarballName(file)
  if (!parsed) return undefined
  for (const scope of ["@opencode", "@opencode-ai"]) {
    const url = `https://registry.npmjs.org/${scope}/cli-${parsed.target}/-/${file}`
    try {
      const total = await fetchTotal(url)
      if (total) return total
    } catch {
      // Try the next scope.
    }
  }
  return undefined
}

/**
 * Watch an upgrade and report its download progress. Returns a stop function.
 * Once the tarball disappears the installer is unpacking it, which is
 * reported as the `installing` phase.
 */
export function startUpgradeProgress(options: UpgradeProgressOptions): () => void {
  const interval = options.intervalMs ?? 800
  const dir = options.tmpDir ?? tmpdir()
  const fetchTotal = options.fetchTotal ?? fetchTotalFromRegistry
  const startedAt = options.startedAt

  let stopped = false
  let sawTarball = false
  let total: number | undefined
  let totalRequested = false
  let lastBytes = 0
  let lastAt = 0
  let speed = 0

  const report = (bytes: number, version: string | undefined): void => {
    const now = Date.now()
    if (lastAt > 0 && bytes > lastBytes) {
      const seconds = (now - lastAt) / 1000
      if (seconds >= 0.2) {
        const instant = (bytes - lastBytes) / seconds
        speed = speed > 0 ? speed * 0.6 + instant * 0.4 : instant
      }
    }
    lastBytes = bytes
    lastAt = now

    const percent =
      total && total > 0
        ? Math.max(0, Math.min(100, Math.round((bytes / total) * 100)))
        : undefined
    options.onUpdate({
      bytes,
      total,
      percent,
      version,
      bytesPerSecond: speed > 0 ? speed : undefined,
      phase: "downloading",
    })
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    const found = findTarball(dir, startedAt)
    if (!found) {
      // The tarball was there and is gone: the installer is unpacking it.
      // Before it appears the CLI is checking the version and fetching the
      // installer — still report, so the elapsed time keeps moving.
      options.onUpdate({ bytes: 0, phase: sawTarball ? "installing" : "preparing" })
      return
    }
    sawTarball = true
    const parsed = parseTarballName(found.file)

    // Report the bytes first — looking the total up in the registry must not
    // hold the first update back.
    report(found.size, parsed?.version)

    if (!totalRequested) {
      totalRequested = true
      void totalFor(found.file, fetchTotal).then((value) => {
        if (stopped || !value) return
        total = value
        void tick()
      })
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, interval)
  timer.unref?.()
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
