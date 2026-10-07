/**
 * End-to-end verification on a real host.
 *
 * Unlike the parser suites, nothing here is injected: `collectStatus` reads
 * the live machine, the junk domain walks real directories, the trash tier
 * hands a real file to the OS Recycle Bin (and the test digs it back out of
 * `$Recycle.Bin` and removes exactly that entry), and the HTTP/tool faces run
 * through the real plugin entry point with a stub cordis context. The
 * Windows-only blocks skip on the other platforms; the artifact block runs
 * everywhere and fails loudly if `lib/` is stale.
 *
 * Timeouts are generous because one Windows round costs a PowerShell start
 * (~2.5-4 s on a host with endpoint security).
 * @module @deepseek-ai/dsh-pc-manager
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { collectStatus } from '../src/monitor.ts'
import { JUNK_TARGETS, cleanJunk, resolveTargets, scanJunk } from '../src/junk.ts'
import type { JunkTarget } from '../src/junk.ts'
import { PS_ARGV, PS_PREAMBLE, resolvePowershell } from '../src/win32.ts'
import { apply, DEFAULT_DASHBOARD_POLL_MS, MIN_DASHBOARD_POLL_MS, name as pluginName } from '../src/index.ts'

const ROUND_TIMEOUT_MS = 180_000
const isWindows = process.platform === 'win32'
const windowsOnly = describe.skipIf(!isWindows)
const run = promisify(execFile)

/* ------------------------------------------------------------------ *
 * Minimal host stubs: just enough cordis for `apply` to register its
 * routes, tools, and approval listener.
 * ------------------------------------------------------------------ */

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void
}

interface StubResponse {
  status: number
  headers: Record<string, string>
  body: string
  ended: boolean
}

/** A response double recording status/headers/body, with SSE `write` support. */
function stubResponse(): { res: unknown, state: StubResponse, whenEnded: Promise<void> } {
  const state: StubResponse = { status: 0, headers: {}, body: '', ended: false }
  let resolveEnded: () => void = () => {}
  const whenEnded = new Promise<void>(resolve => { resolveEnded = resolve })
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      state.status = code
      Object.assign(state.headers, headers ?? {})
      return res
    },
    write(chunk: string | Buffer) {
      state.body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) state.body += chunk.toString()
      state.ended = true
      resolveEnded()
      return res
    },
    on() { return res },
    once() { return res },
  }
  return { res, state, whenEnded }
}

/** A request double: a GET with a URL, or a POST whose body is emitted. */
function stubRequest(method: string, url: string, body?: string): unknown {
  const req = new EventEmitter() as EventEmitter & { method: string, url: string }
  req.method = method
  req.url = url
  if (body !== undefined) {
    // Deliver asynchronously so listeners are attached first.
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
  }
  return req
}

interface HostHarness {
  tools: Array<Record<string, unknown>>
  routes: RegisteredRoute[]
  preExecute: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>
}

/** Run the real `apply()` against a stub context and collect what it registered. */
function mountPlugin(config?: Parameters<typeof apply>[1]): HostHarness {
  const harness: HostHarness = { tools: [], routes: [], preExecute: [] }
  const ctx = {
    tools: { register: (tool: Record<string, unknown>) => { harness.tools.push(tool) } },
    inject: (_services: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') (disposer as () => void)() }
    },
    on: (event: string, handler: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'tools/pre-execute') harness.preExecute.push(handler)
    },
    webServer: { register: (route: RegisteredRoute) => { harness.routes.push(route); return () => {} } },
  }
  apply(ctx as never, config)
  return harness
}

/** Invoke one registered route and await its response. */
async function callRoute(
  harness: HostHarness,
  path: string,
  method = 'GET',
  body?: string,
): Promise<StubResponse> {
  const route = harness.routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path} (have ${harness.routes.map(r => r.path).join(', ')})`)
  const { res, state, whenEnded } = stubResponse()
  route.handler(stubRequest(method, path, body), res)
  await whenEnded
  return state
}

/* ------------------------------------------------------------------ *
 * Real Recycle Bin helpers. These read the on-disk $I/$R record pair
 * Windows writes, which is the strongest available proof that a file
 * really landed in the shell Recycle Bin with its original path.
 * ------------------------------------------------------------------ */

interface RecycledEntry {
  infoPath: string
  payloadPath: string
  originalPath: string
}

/**
 * The `$I<id>` record: an 8-byte version, an 8-byte original size, zero or
 * more further version-dependent binary fields (this machine's shell writes an
 * 8-byte deletion timestamp), then the original path in UTF-16LE,
 * null-terminated. Rather than pin an offset that differs across Windows
 * releases, the path is found by its own signature — the UTF-16LE bytes of
 * `:\` — and decoded from the drive letter that precedes them.
 */
async function readRecycleRecord(infoPath: string): Promise<string> {
  const buffer = await readFile(infoPath)
  const marker = buffer.indexOf(Buffer.from(':\\', 'utf16le'))
  if (marker < 2) return ''
  return buffer.subarray(marker - 2).toString('utf16le').split('\u0000')[0] ?? ''
}

/** Compare original-location records the way the shell does: a `\\?\` prefix
 * and letter case are both noise. */
function sameOriginalPath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/** Find the Recycle Bin entry whose recorded original path is `originalPath`. */
async function findRecycledEntry(originalPath: string): Promise<RecycledEntry | null> {
  const binRoot = join(`${process.env.SystemDrive ?? 'C:'}\\`, '$Recycle.Bin')
  let sidFolders: string[]
  try {
    sidFolders = await readdir(binRoot)
  } catch {
    return null
  }
  for (const sid of sidFolders) {
    let entries: string[]
    try {
      entries = await readdir(join(binRoot, sid))
    } catch {
      continue // another account's bin: not ours to read
    }
    for (const entry of entries) {
      if (!entry.startsWith('$I')) continue
      const infoPath = join(binRoot, sid, entry)
      let original: string
      try {
        original = await readRecycleRecord(infoPath)
      } catch {
        continue
      }
      if (sameOriginalPath(original, originalPath)) {
        return { infoPath, payloadPath: join(binRoot, sid, entry.replace(/^\$I/, '$R')), originalPath: original }
      }
    }
  }
  return null
}

/** Remove exactly one Recycle Bin entry, leaving every other item alone. */
async function dropRecycledEntry(entry: RecycledEntry): Promise<void> {
  await rm(entry.payloadPath, { recursive: true, force: true })
  await rm(entry.infoPath, { force: true })
}

/** A fixture registry row rooted at one concrete path. */
function fixtureTarget(kind: string, path: string, granularity: 'whole' | 'children' = 'whole'): JunkTarget {
  return { kind: kind as JunkTarget['kind'], label: 'e2e fixture', dir: path, safeToClean: true, rationale: 'e2e fixture', granularity }
}

/**
 * Ask the OS directly whether the GPU performance counters exist, so the
 * snapshot's GPU face can be checked for *consistency* with the host's real
 * capability rather than asserted as a fixed value (an idle GPU legitimately
 * reads 0%, and a locked-down host legitimately reads null).
 */
async function gpuCountersAvailable(): Promise<boolean> {
  const bin = await resolvePowershell()
  if (bin === null) return false
  const script = `${PS_PREAMBLE}try { $null = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop; 'yes' } catch { 'no' }`
  const { stdout } = await run(bin, [...PS_ARGV, script], { timeout: 60_000 })
  return stdout.includes('yes')
}

windowsOnly('Windows host end-to-end', () => {
  it('collects a coherent live snapshot', async () => {
    const status = await collectStatus(8)
    expect(status.platform).toBe('win32')
    expect(status.hostname.length).toBeGreaterThan(0)
    expect(status.osVersion).toMatch(/Windows/)
    expect(status.uptimeSeconds).toBeGreaterThan(0)
    expect(status.cpu.model.length).toBeGreaterThan(0)
    expect(status.cpu.cores).toBe(cpus().length)
    expect(status.cpu.loadavg).toBeNull()
    expect(status.cpu.temperatureCelsius === null || status.cpu.temperatureCelsius > -50).toBe(true)
    if (status.cpu.usagePercent !== null) {
      expect(status.cpu.usagePercent).toBeGreaterThanOrEqual(0)
      expect(status.cpu.usagePercent).toBeLessThanOrEqual(100)
    }
    // Memory: the totals come from the node builtins, the split from the bundle.
    expect(status.memory.totalBytes).toBe(totalmem())
    expect(status.memory.usedBytes).toBeGreaterThan(0)
    expect(status.memory.usedBytes).toBeLessThanOrEqual(status.memory.totalBytes)
    expect(status.memory.appMemoryBytes).toBeGreaterThanOrEqual(0)
    expect(status.memory.swapTotalBytes === null || status.memory.swapTotalBytes >= 0).toBe(true)
    // Volumes: the system drive is always there and the arithmetic closes.
    expect(status.disks.length).toBeGreaterThan(0)
    const systemDrive = `${process.env.SystemDrive ?? 'C:'}\\`
    expect(status.disks.map(disk => disk.mount)).toContain(systemDrive)
    for (const disk of status.disks) {
      expect(disk.totalBytes).toBeGreaterThan(0)
      expect(disk.freeBytes).toBeGreaterThanOrEqual(0)
      expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes)
      expect(disk.usedBytes).toBe(disk.totalBytes - disk.freeBytes)
    }
    // Network: at least one non-loopback adapter with counters.
    expect(status.network.length).toBeGreaterThan(0)
    for (const nic of status.network) {
      expect(nic.interface.toLowerCase()).not.toContain('loopback')
      expect(nic.rxBytes).toBeGreaterThanOrEqual(0)
      expect(nic.txBytes).toBeGreaterThanOrEqual(0)
    }
    // Process table: this very process must be visible, with single-core CPU%.
    expect(status.topProcesses.length).toBeGreaterThan(0)
    expect(status.topProcesses.length).toBeLessThanOrEqual(8)
    expect(status.topProcesses.map(row => row.pid)).toContain(process.pid)
    for (const row of status.topProcesses) {
      expect(row.pid).toBeGreaterThan(0)
      expect(row.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(row.rssBytes).toBeGreaterThanOrEqual(0)
      expect(row.command.length).toBeGreaterThan(0)
      // No per-process network source exists on Windows without ETW.
      expect(row.netRxBytes).toBeNull()
      expect(row.netTxBytes).toBeNull()
    }
    expect(Number.isNaN(Date.parse(status.sampledAt))).toBe(false)
    if (status.diskIo.totalBytesPerSec !== null) expect(status.diskIo.totalBytesPerSec).toBeGreaterThanOrEqual(0)
    // GPU: the snapshot must agree with the host's actual capability. The
    // counter class is the vendor-agnostic source (it works on the AMD iGPU of
    // this machine, where nvidia-smi has nothing to say), so its presence must
    // surface as a measured percentage — 0 while idle, never null.
    const gpuCapable = await gpuCountersAvailable()
    if (gpuCapable) {
      expect(status.gpu.usagePercent, 'the GPU engine counters exist, so the GPU face must be measured').not.toBeNull()
      expect(status.gpu.usagePercent).toBeGreaterThanOrEqual(0)
      expect(status.gpu.usagePercent).toBeLessThanOrEqual(100)
      // …and the card can name the adapter it is reporting on.
      expect(status.gpu.name, 'a host with GPU counters has a display adapter to name').toBeTruthy()
    } else {
      expect(status.gpu.usagePercent === null || status.gpu.usagePercent >= 0).toBe(true)
    }
    // Per-process GPU comes from the same counters; every attributed row must
    // stay inside the single-core-free 0-100 scale.
    for (const row of status.topProcesses) {
      if (row.gpuPercent === null) continue
      expect(row.gpuPercent).toBeGreaterThan(0)
      expect(row.gpuPercent).toBeLessThanOrEqual(100)
    }
  }, ROUND_TIMEOUT_MS)

  it('runs a real read-only junk scan of the live registry', async () => {
    const report = await scanJunk({ kinds: ['trash'] })
    expect(Array.isArray(report.items)).toBe(true)
    expect(Array.isArray(report.skipped)).toBe(true)
    expect(report.totalBytes).toBe(report.items.reduce((sum, item) => sum + item.sizeBytes, 0))
    const systemDrive = (process.env.SystemDrive ?? 'C:').toLowerCase()
    for (const item of report.items) {
      expect(item.kind).toBe('trash')
      expect(item.path.toLowerCase().startsWith(systemDrive)).toBe(true)
    }
    // Every registered Windows row resolves to a concrete path on this host.
    const rows = resolveTargets(JUNK_TARGETS)
    expect(rows).toHaveLength(18)
    for (const row of rows) expect(row.dir).not.toContain('%')
  }, ROUND_TIMEOUT_MS)

  it('hands a fixture file to the real Recycle Bin, then removes just that entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-e2e-recycle-'))
    const home = await mkdtemp(join(tmpdir(), 'pc-e2e-home-'))
    const file = join(dir, 'recycle-me.bin')
    await writeFile(file, Buffer.alloc(4096, 7))
    let entry: RecycledEntry | null = null
    try {
      const result = await cleanJunk([`user-caches:${file}`], 'trash', [fixtureTarget('user-caches', file)], { home })
      expect(result.mode).toBe('trash')
      expect(result.outcomes).toEqual([{ id: `user-caches:${file}`, reclaimedBytes: 4096 }])
      expect(result.totalReclaimedBytes).toBe(4096)
      // Gone from where it was…
      expect(existsSync(file)).toBe(false)
      // …and the tier-1 shell API (not the tier-2 holding directory) took it.
      expect(existsSync(join(home, 'AppData', 'Local', 'pc-manager', 'trash'))).toBe(false)
      entry = await findRecycledEntry(file)
      expect(entry, 'the file must be listed in the real Recycle Bin with its original path').not.toBeNull()
    } finally {
      if (entry !== null) await dropRecycledEntry(entry)
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
    expect(existsSync(file)).toBe(false)
    expect(await findRecycledEntry(file)).toBeNull()
  }, ROUND_TIMEOUT_MS)

  it('deletes a fixture permanently in delete mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pc-e2e-delete-'))
    try {
      const item = join(dir, 'item')
      await mkdir(item)
      await writeFile(join(item, 'a.bin'), Buffer.alloc(1024, 1))
      await writeFile(join(item, 'b.bin'), Buffer.alloc(2048, 1))
      const result = await cleanJunk([`user-caches:${item}`], 'delete', [fixtureTarget('user-caches', item)], { home: dir })
      expect(result.mode).toBe('delete')
      expect(result.totalReclaimedBytes).toBe(3072)
      expect(existsSync(item)).toBe(false)
      expect(await findRecycledEntry(item)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, ROUND_TIMEOUT_MS)

  it('serves the real status/junk HTTP faces through apply()', async () => {
    const harness = mountPlugin({ dashboardPollMs: MIN_DASHBOARD_POLL_MS })
    expect(harness.routes.map(route => route.path).sort()).toEqual([
      '/pc-manager/junk/clean', '/pc-manager/junk/scan', '/pc-manager/status', '/pc-manager/stream',
    ])
    // /status: a real snapshot on the wire.
    const statusResponse = await callRoute(harness, '/pc-manager/status', 'GET')
    expect(statusResponse.status).toBe(200)
    expect(statusResponse.headers['x-pc-manager-poll-ms']).toBe(String(MIN_DASHBOARD_POLL_MS))
    const payload = JSON.parse(statusResponse.body) as Record<string, unknown>
    expect(payload.platform).toBe('win32')
    expect(Array.isArray(payload.disks)).toBe(true)
    expect(Array.isArray(payload.topProcesses)).toBe(true)
    expect((payload.cpu as { loadavg: unknown }).loadavg).toBeNull()
    // /junk/scan: a real read-only walk, with one meta row per registered kind.
    const scanResponse = await callRoute(harness, '/pc-manager/junk/scan', 'GET')
    expect(scanResponse.status).toBe(200)
    const scan = JSON.parse(scanResponse.body) as { items: unknown[], kindMeta: unknown[], totalBytes: number, moveToTrash: boolean }
    expect(scan.kindMeta).toHaveLength(11)
    expect(Array.isArray(scan.items)).toBe(true)
    expect(scan.moveToTrash).toBe(true)
    // Wrong method is refused before any probe runs.
    expect((await callRoute(harness, '/pc-manager/junk/scan', 'POST')).status).toBe(405)
  }, ROUND_TIMEOUT_MS)

  it('refuses the clean route when the config gate is closed and when an id escapes its root', async () => {
    const closed = mountPlugin()
    const refused = await callRoute(closed, '/pc-manager/junk/clean', 'POST', JSON.stringify({ ids: ['user-caches:C:\\Temp\\x'] }))
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'disabled_by_config' })

    const open = mountPlugin({ enableJunkClean: true })
    // A well-formed id that is neither registered nor inside a registered root
    // must be refused whole — nothing may be deleted.
    const escaping = await callRoute(open, '/pc-manager/junk/clean', 'POST', JSON.stringify({ ids: ['user-caches:C:\\Windows\\System32\\kernel32.dll'] }))
    expect(escaping.status).toBe(400)
    expect(JSON.parse(escaping.body)).toMatchObject({ code: 'invalid_argument' })
    const blocked = await callRoute(open, '/pc-manager/junk/clean', 'POST', JSON.stringify({ ids: ['system-temp:C:\\Windows\\Temp\\x'] }))
    expect(blocked.status).toBe(403)
    expect(JSON.parse(blocked.body)).toMatchObject({ code: 'unsafe_target' })
    const malformed = await callRoute(open, '/pc-manager/junk/clean', 'POST', JSON.stringify({ ids: [] }))
    expect(malformed.status).toBe(400)
    expect((await callRoute(open, '/pc-manager/junk/clean', 'GET')).status).toBe(405)
    // The real system file the probe aimed at is still there.
    expect(existsSync('C:\\Windows\\System32\\kernel32.dll')).toBe(true)
  }, ROUND_TIMEOUT_MS)

  it('runs the real tools and keeps the destructive ones behind the config gate', async () => {
    const harness = mountPlugin({ enableJunkClean: true, askBeforeJunkClean: true })
    expect(harness.tools.map(tool => tool.name).sort()).toEqual([
      'pc_app_uninstall', 'pc_apps_list', 'pc_junk_clean', 'pc_junk_scan', 'pc_status',
    ])
    const exec = { signal: new AbortController().signal }
    const status = harness.tools.find(tool => tool.name === 'pc_status') as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    const snapshot = await status.execute({}, exec)
    expect(snapshot.platform).toBe('win32')
    expect(snapshot.code).toBeUndefined()

    const scan = harness.tools.find(tool => tool.name === 'pc_junk_scan') as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    const report = await scan.execute({ kinds: ['trash'], minItemBytes: 1024 * 1024 }, exec)
    expect(report.code).toBeUndefined()
    expect(Array.isArray(report.items)).toBe(true)

    // The approval gate is installed and summarizes the batch bilingually.
    expect(harness.preExecute).toHaveLength(1)
    const decision = await harness.preExecute[0]?.(
      { name: 'pc_junk_clean', arguments: { ids: ['trash:C:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001'] } },
      async () => ({ kind: 'next' }),
    ) as { kind: string, displayReason: { en: string, zh: string } }
    expect(decision.kind).toBe('ask')
    expect(decision.displayReason.en).toContain('1 item')
    expect(decision.displayReason.zh).toContain('清理 1 项')

    // A disabled host refuses the destructive tools instead of running them.
    const disabled = mountPlugin({ enableJunkClean: false, enableAppUninstall: false })
    const clean = disabled.tools.find(tool => tool.name === 'pc_junk_clean') as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    expect(await clean.execute({ ids: ['trash:x'] }, exec)).toMatchObject({ code: 'disabled_by_config' })
    const uninstall = disabled.tools.find(tool => tool.name === 'pc_app_uninstall') as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    expect(await uninstall.execute({ id: 'x' }, exec)).toMatchObject({ code: 'disabled_by_config' })
  }, ROUND_TIMEOUT_MS)
})

/**
 * Import a committed JS artifact. The specifier is built at runtime so the
 * type checker does not demand declarations for the build output (and so the
 * test always loads what `lib/` holds right now, not an inferred shape).
 */
async function importArtifact(relative: string): Promise<Record<string, unknown>> {
  const url = new URL(relative, import.meta.url).href
  return await import(url) as Record<string, unknown>
}

describe('committed build artifacts', () => {
  it('loads the host artifact and exposes the plugin contract', async () => {
    const host = await importArtifact('../lib/index.js')
    expect(host.name).toBe(pluginName)
    expect(host.name).toBe('pc-manager')
    expect(host.inject).toEqual(['tools'])
    expect(typeof host.apply).toBe('function')
    expect(host.Config).toBeDefined()
    expect(host.MIN_DASHBOARD_POLL_MS).toBe(500)
    expect(host.DEFAULT_DASHBOARD_POLL_MS).toBe(DEFAULT_DASHBOARD_POLL_MS)
    // The artifact's own apply() must register the same five tools and the
    // same four routes: this is the check that catches a stale lib/ after a
    // source change. The harness starts empty so the counts are exact.
    const harness: HostHarness = { tools: [], routes: [], preExecute: [] }
    const builtCtx = {
      tools: { register: (tool: Record<string, unknown>) => { harness.tools.push(tool) } },
      inject: (_services: string[], callback: (ctx: unknown) => void) => { callback(builtCtx) },
      effect: (fn: () => unknown) => { fn(); return () => {} },
      on: () => {},
      webServer: { register: (route: RegisteredRoute) => { harness.routes.push(route); return () => {} } },
    }
    ;(host.apply as (ctx: unknown, config: unknown) => void)(builtCtx, {})
    expect(harness.tools.map(tool => tool.name).sort()).toEqual([
      'pc_app_uninstall', 'pc_apps_list', 'pc_junk_clean', 'pc_junk_scan', 'pc_status',
    ])
    expect(harness.routes.map(route => route.path)).toHaveLength(4)

    // Staleness canary: the committed bundle embeds the registries and the
    // probe scripts as data, so a few literal markers prove lib/ was rebuilt
    // after the Windows support landed. (A contract test would be the wrong
    // shape here — this only asserts "the artifact is not older than the
    // source", which the counts above cannot see for a same-shaped change.)
    // Markers avoid backslashes: the bundle text carries the escaped form.
    const bundleText = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
    for (const marker of ['$Recycle.Bin', 'MSAcpi_ThermalZoneTemperature', 'SendToRecycleBin']) {
      expect(bundleText, `lib/index.js is stale: it does not contain ${marker}`).toContain(marker)
    }
  })

  it('instantiates the browser artifact through the module-loader contract', async () => {
    const loaded: Array<{ id: string, factory: (require: (specifier: string) => unknown) => unknown }> = []
    const globals = globalThis as { window?: unknown }
    const previousWindow = globals.window
    globals.window = { __ModuleLoader__: { load: (mod: (typeof loaded)[number]) => { loaded.push(mod) } } }
    try {
      await importArtifact('../lib/client.js')
    } finally {
      globals.window = previousWindow
    }
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('dsh-pc-manager')
    // Calling the factory exercises the bundled client module graph with the
    // only runtime externals the contract allows: react and its JSX runtime.
    const localRequire = createRequire(import.meta.url)
    const exports = loaded[0]?.factory(specifier => localRequire(specifier)) as { inject?: unknown, apply?: unknown }
    expect(typeof exports.apply).toBe('function')
    expect(exports.inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
  })
})
