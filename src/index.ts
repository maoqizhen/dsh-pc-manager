/**
 * @deepseek-ai/dsh-pc-manager — 电脑管家 for DeepSeek Harness: system junk
 * cleanup, software uninstall, and system status monitoring, exposed as five
 * model-facing tools (`pc_status`, `pc_junk_scan`, `pc_junk_clean`,
 * `pc_apps_list`, `pc_app_uninstall`).
 *
 * Safety stance: read-only tools work out of the box; both destructive tools
 * register but refuse with `disabled_by_config` until the host opts in via
 * the patch config, and when enabled they default to the Trash (recoverable)
 * over permanent deletion. The domain modules carry no cordis imports, so
 * they stay unit-testable outside the harness.
 * @module @deepseek-ai/dsh-pc-manager
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the webServer Context augmentation; erased at runtime.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import {
  collectStatus, createIpGeoLookup, DEFAULT_TOP_PROCESSES, diffNetRates, diffProcessRates,
  MAX_PROCESS_LIMIT, sortByNetworkRate, unionProcessRows,
} from './monitor.ts'
import type { IpGeoLookup, ProcessRateState } from './monitor.ts'
import { isRecommendedItem, JUNK_TARGETS, RECOMMENDED_PLAN, cleanJunk, scanJunk } from './junk.ts'
import type { JunkItem } from './types.ts'
import { PcManagerError } from './types.ts'
import type { ProcessInfo, SystemStatus } from './types.ts'
import type { ProcessSort } from './types.ts'
import { registerPcManagerTools } from './tools.ts'

export const name = 'pc-manager'
export const inject = ['tools']

/** Lowest poll interval the dashboard accepts, so a client cannot hammer the probes. */
export const MIN_DASHBOARD_POLL_MS = 500

/** Default dashboard poll interval advertised to the web client. */
export const DEFAULT_DASHBOARD_POLL_MS = 2_000

/** Default public-ip geolocation endpoint (HTTPS, keyless, ipwho.is-compatible JSON). */
export const DEFAULT_IP_GEO_ENDPOINT = 'https://ipwho.is/'

/** Default minutes a successful public-ip lookup stays cached. */
export const DEFAULT_IP_GEO_REFRESH_MINUTES = 30

/** Lowest accepted cache minutes — the lookup must not track the poll cadence. */
export const MIN_IP_GEO_REFRESH_MINUTES = 5

/** Plugin configuration. */
export interface Config {
  /** Allow pc_junk_clean to actually reclaim (default false). */
  enableJunkClean?: boolean
  /** Allow pc_app_uninstall to actually remove apps (default false). */
  enableAppUninstall?: boolean
  /** Move reclaimed bytes to the Trash instead of deleting (default true). */
  moveToTrash?: boolean
  /**
   * Keep the host-side pre-execute approval prompt for every pc_junk_clean
   * call (default true). Headless profiles without an approval answerer fail
   * closed; turning this off requires writing `false` explicitly.
   */
  askBeforeJunkClean?: boolean
  /** Row cap for pc_status top processes (default 10). */
  maxTopProcesses?: number
  /** Dashboard poll interval in ms, advertised to the web client via response header (default 2000, min 500). */
  dashboardPollMs?: number
  /**
   * Look up the public IP's geolocation from an external HTTPS service
   * (default true). This is the plugin's only outbound third-party request;
   * the response is cached per {@link ipGeoRefreshMinutes}, and turning this
   * off leaves `publicIp` null while local addresses keep working.
   */
  enableIpGeoLookup?: boolean
  /** Minutes a successful public-ip lookup stays cached (default 30, min 5). */
  ipGeoRefreshMinutes?: number
  /** ipwho.is-compatible HTTPS endpoint for the lookup (default ipwho.is; swap for a reachable mirror). */
  ipGeoEndpoint?: string
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  enableJunkClean: z.boolean().default(false),
  enableAppUninstall: z.boolean().default(false),
  moveToTrash: z.boolean().default(true),
  askBeforeJunkClean: z.boolean().default(true),
  maxTopProcesses: z.natural().default(DEFAULT_TOP_PROCESSES),
  dashboardPollMs: z.natural().default(DEFAULT_DASHBOARD_POLL_MS),
  enableIpGeoLookup: z.boolean().default(true),
  ipGeoRefreshMinutes: z.natural().default(DEFAULT_IP_GEO_REFRESH_MINUTES),
  ipGeoEndpoint: z.string().default(DEFAULT_IP_GEO_ENDPOINT),
})

/** Validate the dashboard route's `processSort` query parameter. */
function processSort(value: string | null): ProcessSort {
  return value === 'mem' || value === 'network' ? value : 'cpu'
}

/** Clamp the dashboard route's `processLimit` query parameter. */
function processLimit(value: string | null, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, MAX_PROCESS_LIMIT)
}

/** One pushed dashboard frame: the snapshot plus server-derived rates. */
export interface DashboardFrame {
  status: SystemStatus
  /** Per-interface byte rates from consecutive pump samples; empty until the second round. */
  netRates: Readonly<Record<string, { rxPerSec: number, txPerSec: number }>>
  /** Per-pid network rates over each process's own window; keyed by pid as a string. */
  processRates: Readonly<Record<string, { rxPerSec: number, txPerSec: number }>>
  /** Rows ranked by live network rate (falls back to cumulative counters on the first frame). */
  topByNetwork: readonly ProcessInfo[]
  /** The pump's sampling interval, so clients can size history windows. */
  pollMs: number
}

/**
 * The single sampling pump: one timer, one probe round per interval, shared by
 * every consumer. The timer runs only while at least one SSE subscriber (or a
 * cache-missing HTTP request) holds a reference, so a hidden dashboard costs
 * nothing. Each round also derives per-interface and per-process rates against
 * the previous frames, which is why pushed frames carry rates from the second
 * frame on. The `SystemStatus` wire keeps cumulative process counters — the
 * pc_status tool contract stays untouched; rates are a dashboard-layer extra.
 */
class SnapshotPump {
  private readonly listeners = new Set<(frame: DashboardFrame) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private latest: DashboardFrame | undefined
  private inflight: Promise<DashboardFrame> | undefined
  private processSeen: ReadonlyMap<number, ProcessRateState> = new Map()

  constructor(
    private readonly pollMs: number,
    private readonly maxTop: number,
    private readonly ipGeo: IpGeoLookup | null = null,
  ) {}

  acquire(listener: (frame: DashboardFrame) => void): () => void {
    this.listeners.add(listener)
    if (this.latest !== undefined) listener(this.latest)
    if (this.timer === undefined) {
      this.start()
      // First subscriber gets a frame right away instead of after one interval.
      void this.ensureFresh().catch(() => {})
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** A fresh-enough frame for HTTP callers; collects only when the cache went stale. */
  async ensureFresh(): Promise<DashboardFrame> {
    const age = this.latest === undefined ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(this.latest.status.sampledAt)
    if (Number.isFinite(age) && age < this.pollMs) return this.latest as DashboardFrame
    this.inflight ??= this.collect().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private start(): void {
    this.timer = setInterval(() => {
      // Overlapping rounds are pointless: the probes take ~1s on their own clock.
      if (this.running) return
      void this.collect().catch(() => {})
    }, this.pollMs)
  }

  private stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private async collect(): Promise<DashboardFrame> {
    this.running = true
    try {
      const prev = this.latest?.status ?? null
      // The union (CPU top-N ∪ socket processes) is what rate windows track:
      // a socket-heavy process outside the CPU list keeps its per-pid history.
      let union: readonly ProcessInfo[] = []
      const status = await collectStatus(this.maxTop, 'cpu', {
        onProcessTable: table => {
          union = unionProcessRows(table, this.maxTop)
        },
        ipGeo: this.ipGeo,
      })
      const rates = diffNetRates(prev, status)
      const processDiff = diffProcessRates(this.processSeen, union, status.sampledAt)
      this.processSeen = processDiff.nextLastSeen
      const frame: DashboardFrame = {
        status,
        netRates: Object.fromEntries([...rates.entries()].map(([name, rate]) => [name, rate])),
        processRates: Object.fromEntries([...processDiff.rates.entries()].map(([pid, rate]) => [String(pid), rate])),
        topByNetwork: sortByNetworkRate(union, processDiff.rates, this.maxTop),
        pollMs: this.pollMs,
      }
      this.latest = frame
      for (const listener of this.listeners) listener(frame)
      return frame
    } finally {
      this.running = false
    }
  }
}

/**
 * Serve the dashboard's data faces when the web profile provides a server:
 * an SSE stream (the shared base — one pump, every consumer) and a cached
 * JSON route as the fallback for one-shot callers. Headless profiles never
 * inject webServer, so this stays a no-op there.
 */
function serveDashboard(ctx: Context, pollMs: number, defaultLimit: number, ipGeo: IpGeoLookup | null): void {  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = webCtx.webServer
    const pump = new SnapshotPump(pollMs, defaultLimit, ipGeo)
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/pc-manager/stream',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        // A warm frame first, then every pump round; the release on socket
        // close is what makes an abandoned tab free the server's probes.
        const release = pump.acquire(frame => {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        })
        req.on('close', release)
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/pc-manager/status',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const requested = processLimit(url.searchParams.get('processLimit'), defaultLimit)
          const requestedSort = processSort(url.searchParams.get('processSort'))
          // The pump cache holds exactly the default ranking; anything else
          // (a different sort or limit) collects on the spot.
          const status = requested === defaultLimit && requestedSort === 'cpu'
            ? (await pump.ensureFresh()).status
            : await collectStatus(requested, requestedSort, { ipGeo })
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'x-pc-manager-poll-ms': String(pollMs),
          })
          res.end(JSON.stringify(status))
        })().catch((error: unknown) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ code: 'internal_error', message: String(error) }))
        })
      },
    }))
  })
}

/**
 * The dashboard plan card's faces (§16.8): a read-only scan pre-filtered to
 * plan-worthy items (≥ the preset threshold, so small entries never reach the
 * UI), plus a direct clean endpoint so the card executes without any LLM
 * round-trip — the config gate and the id validation chain inside
 * {@link cleanJunk} are exactly the tool's own.
 */
function serveJunkFaces(ctx: Context, config: Config): void {
  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = webCtx.webServer
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/pc-manager/junk/scan',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' })
            res.end(JSON.stringify({ code: 'invalid_argument', message: 'GET only' }))
            return
          }
          const report = await scanJunk({ minItemBytes: RECOMMENDED_PLAN.minItemBytes })
          const items: Array<JunkItem & { recommendedDefault: boolean }> =
            report.items.map(item => ({ ...item, recommendedDefault: isRecommendedItem(item) }))
          // One meta row per kind (system-temp's two roots collapse to the first label).
          const kindMeta: Array<{ kind: string, label: string, safeToClean: boolean, rationale: string, recommended: boolean }> = []
          for (const target of JUNK_TARGETS) {
            if (kindMeta.some(meta => meta.kind === target.kind)) continue
            kindMeta.push({
              kind: target.kind,
              label: target.label,
              safeToClean: target.safeToClean,
              rationale: target.rationale,
              recommended: RECOMMENDED_PLAN.kinds.includes(target.kind),
            })
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({
            items,
            kindMeta,
            totalBytes: report.totalBytes,
            skipped: report.skipped,
            scannedAt: report.scannedAt,
            moveToTrash: config.moveToTrash ?? true,
          }))
        })().catch((error: unknown) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ code: 'internal_error', message: String(error) }))
        })
      },
    }))
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/pc-manager/junk/clean',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' })
            res.end(JSON.stringify({ code: 'invalid_argument', message: 'POST only' }))
            return
          }
          const send = (status: number, payload: unknown): void => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(payload))
          }
          if (!(config.enableJunkClean ?? false)) {
            send(403, { code: 'disabled_by_config', message: 'junk cleaning is disabled; set pc-manager.enableJunkClean to opt in.' })
            return
          }
          const body = await new Promise<unknown>((resolve, reject) => {
            let raw = ''
            req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
            req.on('end', () => {
              try {
                resolve(raw.length > 0 ? JSON.parse(raw) : {})
              } catch (error) {
                reject(error)
              }
            })
            req.on('error', reject)
          })
          const ids = (body as { ids?: unknown }).ids
          if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string' && id.length > 0)) {
            send(400, { code: 'invalid_argument', message: 'junk clean requires a non-empty array of item ids.' })
            return
          }
          const mode = config.moveToTrash ?? true ? 'trash' : 'delete'
          const result = await cleanJunk(ids as string[], mode)
          const failed = result.outcomes.filter(outcome => outcome.error !== undefined).length
          console.warn(`[pc-manager] junk clean via dashboard: ${ids.length} ids, mode ${mode}, `
            + `reclaimed ${result.totalReclaimedBytes} bytes, ${failed} failed`)
          send(200, result)
        })().catch((error: unknown) => {
          if (error instanceof PcManagerError) {
            const status = error.code === 'invalid_argument' ? 400 : error.code === 'unsafe_target' ? 403 : 500
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ code: error.code, message: error.message }))
            return
          }
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ code: 'internal_error', message: String(error) }))
        })
      },
    }))
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  // The pump skips overlapping rounds, so a Windows host (one PowerShell bundle
  // per round, ~2.5-4.5 s) simply runs at its own cadence whatever the client
  // asks for — the configured interval stays a floor on Linux/macOS rather than
  // something the host silently rewrites per platform.
  const pollMs = Math.max(MIN_DASHBOARD_POLL_MS, config.dashboardPollMs ?? DEFAULT_DASHBOARD_POLL_MS)
  const maxTopProcesses = config.maxTopProcesses ?? DEFAULT_TOP_PROCESSES
  const ipGeo = config.enableIpGeoLookup ?? true
    ? createIpGeoLookup({
      endpoint: config.ipGeoEndpoint ?? DEFAULT_IP_GEO_ENDPOINT,
      refreshMs: Math.max(MIN_IP_GEO_REFRESH_MINUTES, config.ipGeoRefreshMinutes ?? DEFAULT_IP_GEO_REFRESH_MINUTES) * 60_000,
    })
    : null
  // Warm the cache at startup so the first dashboard frame usually already
  // carries the geo; the lookup itself swallows every failure.
  if (ipGeo !== null) void ipGeo()
  serveDashboard(ctx, pollMs, maxTopProcesses, ipGeo)
  serveJunkFaces(ctx, config)
  registerPcManagerTools(ctx, {
    enableJunkClean: config.enableJunkClean ?? false,
    enableAppUninstall: config.enableAppUninstall ?? false,
    moveToTrash: config.moveToTrash ?? true,
    askBeforeJunkClean: config.askBeforeJunkClean ?? true,
    maxTopProcesses,
    ipGeo,
  })
}
