/**
 * Model-facing 电脑管家 tools over the domain modules: one read-only status
 * probe, two junk tools (scan is always dry-run; clean is config-gated), and
 * two app tools (list is read-only; uninstall is config-gated). Destructive
 * tools are registered but refuse with `disabled_by_config` until the host
 * opts in — the model sees the capability, the host owns the switch.
 * @module @deepseek-ai/dsh-pc-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { collectStatus } from './monitor.ts'
import { JUNK_KINDS, cleanJunk, describeJunkIds, scanJunk } from './junk.ts'
import { listApps, uninstallApp } from './apps.ts'
import type { JunkKind, PcErrorValue } from './types.ts'
import { PcManagerError } from './types.ts'

/** Resolved switches the tool layer needs; the plugin schema supplies defaults. */
export interface ToolsConfig {
  enableJunkClean: boolean
  enableAppUninstall: boolean
  moveToTrash: boolean
  /** Keep the host-side pre-execute approval prompt for pc_junk_clean (default true). */
  askBeforeJunkClean: boolean
  maxTopProcesses: number
}

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      required: true,
      enum: ['not_implemented', 'unsupported_platform', 'invalid_argument', 'not_found', 'disabled_by_config', 'unsafe_target', 'internal_error'],
    },
    message: { type: 'string', required: true },
  },
} as const

/** Nullable scalar as the schema DSL's exact-one `oneOf`, keeping `type` literal for inference. */
const nullable = <T extends 'string' | 'number' | 'boolean'>(schema: { type: T }) =>
  ({ oneOf: [schema, { type: 'null' as const }] }) as const

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    platform: { type: 'string', required: true },
    hostname: { type: 'string', required: true },
    osVersion: nullable({ type: 'string' }),
    uptimeSeconds: { type: 'number', required: true },
    cpu: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        model: { type: 'string', required: true },
        cores: { type: 'number', required: true },
        usagePercent: nullable({ type: 'number' }),
        loadavg: { type: 'array', required: true, items: { type: 'number' } },
        temperatureCelsius: nullable({ type: 'number' }),
      },
    },
    gpu: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        usagePercent: nullable({ type: 'number' }),
      },
    },
    memory: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        totalBytes: { type: 'number', required: true },
        usedBytes: { type: 'number', required: true },
        appMemoryBytes: { type: 'number', required: true },
        wiredBytes: nullable({ type: 'number' }),
        compressedBytes: nullable({ type: 'number' }),
        cachedBytes: nullable({ type: 'number' }),
        purgeableBytes: nullable({ type: 'number' }),
        swapTotalBytes: nullable({ type: 'number' }),
        swapUsedBytes: nullable({ type: 'number' }),
      },
    },
    diskIo: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        totalBytesPerSec: nullable({ type: 'number' }),
      },
    },
    disks: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mount: { type: 'string', required: true },
          filesystem: { type: 'string', required: true },
          totalBytes: { type: 'number', required: true },
          usedBytes: { type: 'number', required: true },
          freeBytes: { type: 'number', required: true },
        },
      },
    },
    battery: {
      oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          percent: nullable({ type: 'number' }),
          charging: nullable({ type: 'boolean' }),
          powerSource: nullable({ type: 'string' }),
          timeRemainingMinutes: nullable({ type: 'number' }),
          cycleCount: nullable({ type: 'number' }),
          healthPercent: nullable({ type: 'number' }),
        },
      }, { type: 'null' as const }],
    },
    network: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interface: { type: 'string', required: true },
          rxBytes: { type: 'number', required: true },
          txBytes: { type: 'number', required: true },
        },
      },
    },
    topProcesses: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'number', required: true },
          cpuPercent: { type: 'number', required: true },
          memPercent: { type: 'number', required: true },
          rssBytes: { type: 'number', required: true },
          command: { type: 'string', required: true },
          netRxBytes: nullable({ type: 'number' }),
          netTxBytes: nullable({ type: 'number' }),
          gpuPercent: nullable({ type: 'number' }),
          diskReadBytes: nullable({ type: 'number' }),
          diskWrittenBytes: nullable({ type: 'number' }),
        },
      },
    },
    sampledAt: { type: 'string', required: true },
  },
} as const

const JUNK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: [...JUNK_KINDS] },
    label: { type: 'string', required: true },
    path: { type: 'string', required: true },
    sizeBytes: { type: 'number', required: true },
    fileCount: { type: 'number', required: true },
    safeToClean: { type: 'boolean', required: true },
    rationale: { type: 'string', required: true },
    lastModifiedAt: nullable({ type: 'string' }),
  },
} as const

const JUNK_SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', required: true, items: JUNK_ITEM_SCHEMA },
    totalBytes: { type: 'number', required: true },
    skipped: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        },
      },
    },
    scannedAt: { type: 'string', required: true },
  },
} as const

const JUNK_CLEAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outcomes: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          reclaimedBytes: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
    },
    totalReclaimedBytes: { type: 'number', required: true },
    mode: { type: 'string', required: true, enum: ['trash', 'delete'] },
    cleanedAt: { type: 'string', required: true },
  },
} as const

const APP_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['app-bundle', 'homebrew', 'system'] },
    path: { type: 'string', required: true },
    sizeBytes: { type: 'number', required: true },
    lastUsedAt: { type: 'string' },
  },
} as const

const APPS_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    apps: { type: 'array', required: true, items: APP_ENTRY_SCHEMA },
    scannedAt: { type: 'string', required: true },
  },
} as const

const APP_UNINSTALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    uninstalled: { type: 'boolean', required: true },
    mode: { type: 'string', required: true, enum: ['trash', 'delete'] },
    leftovers: { type: 'array', required: true, items: { type: 'string' } },
    uninstalledAt: { type: 'string', required: true },
  },
} as const

/** Deterministic model content: the canonical JSON the schema validated. */
function renderValue(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Pure generic pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Run one domain call, translating failures into the closed error union. */
async function guarded<T>(task: () => Promise<T>): Promise<T | PcErrorValue> {
  try {
    return await task()
  } catch (error: unknown) {
    return error instanceof PcManagerError
      ? { code: error.code, message: error.message }
      : { code: 'internal_error', message: String(error) }
  }
}

/** Register all five 电脑管家 tools in one plugin context. */
export function registerPcManagerTools(ctx: Context, config: ToolsConfig): void {
  ctx.tools.register(defineTool({
    name: 'pc_status',
    description: 'Read one system status snapshot: CPU model/cores/utilization/load average '
      + '(and package temperature when the host exposes a sensor), GPU utilization (best-effort), '
      + 'memory pressure breakdown with swap, disk I/O throughput and per-volume usage, battery/power, '
      + 'per-interface network counters, and ranked processes (CPU, memory, or network). Read-only; '
      + 'safe to call any time.',
    parameters: {},
    output: { schema: { oneOf: [STATUS_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    execute: () => guarded(() => collectStatus(config.maxTopProcesses)),
    presentCall: () => present('System status', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'pc_junk_scan',
    description: 'Enumerate reclaimable junk on this host — Trash, user caches, system temp, package-manager '
      + 'caches (npm/pnpm/pip/uv/yarn/go/Homebrew), and on macOS also user logs, Xcode build artifacts, '
      + 'simulator leftovers, and iOS device backups — with per-item sizes, safety notes, and suggested '
      + 'commands for items that must not be deleted directly. Always a dry run: scanning deletes nothing. '
      + 'After scanning, present a per-category summary to the user and ask which categories or items to '
      + 'clean — prefer the ask_user_question tool for that choice when it is available — before ever calling '
      + 'pc_junk_clean.',
    parameters: {
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...JUNK_KINDS] },
        description: 'Optional junk kinds to include; omit to scan all registered kinds.',
      },
      minItemBytes: {
        type: 'number',
        description: 'Optional minimum item size in bytes; smaller items are omitted from the report.',
      },
    },
    output: { schema: { oneOf: [JUNK_SCAN_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    execute: (args: { kinds?: unknown, minItemBytes?: unknown }, exec: { signal: AbortSignal }) =>
      guarded(() => scanJunk({
        kinds: Array.isArray(args.kinds)
          ? args.kinds.filter((kind): kind is JunkKind => typeof kind === 'string' && (JUNK_KINDS as readonly string[]).includes(kind))
          : undefined,
        minItemBytes: typeof args.minItemBytes === 'number' && Number.isFinite(args.minItemBytes) && args.minItemBytes > 0
          ? args.minItemBytes
          : undefined,
        signal: exec.signal,
      })),
    presentCall: () => present('Scan junk', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'pc_junk_clean',
    description: 'Reclaim the junk items whose exact ids were returned by pc_junk_scan. Only call '
      + 'this after the user has explicitly confirmed the exact selection and the destination '
      + '(Trash by default, recoverable); restate the items and sizes when asking, prefer '
      + 'ask_user_question for the confirmation when available. Permanent deletion is only '
      + 'possible when the host config sets moveToTrash to false — say so instead of retrying if '
      + 'the user asks for it. Items from targets marked safeToClean:false are refused with '
      + 'unsafe_target; relay their suggested commands instead. Refuses with disabled_by_config '
      + 'until the host enables junk cleaning; a host-side approval prompt may also confirm the run.',
    parameters: {
      ids: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Exact junk item ids from a prior pc_junk_scan.',
      },
    },
    output: { schema: { oneOf: [JUNK_CLEAN_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args: { ids?: unknown }, exec: { signal: AbortSignal }) {
      if (!config.enableJunkClean) {
        return { code: 'disabled_by_config' as const, message: 'junk cleaning is disabled; set pc-manager.enableJunkClean to opt in.' }
      }
      if (!Array.isArray(args.ids) || args.ids.length === 0 || !args.ids.every(id => typeof id === 'string' && id.length > 0)) {
        return { code: 'invalid_argument' as const, message: 'pc_junk_clean requires a non-empty array of junk item ids from pc_junk_scan.' }
      }
      return guarded(() => cleanJunk(args.ids as string[], config.moveToTrash ? 'trash' : 'delete', undefined, { signal: exec.signal }))
    },
    presentCall: (args: unknown) => present('Clean junk', 'other', args),
  }))

  ctx.tools.register(defineTool({
    name: 'pc_apps_list',
    description: 'List installed applications (app bundles and Homebrew formulae/casks on macOS; '
      + 'distro packages on Linux once M3 lands) with sizes and last-launch times when observable. '
      + 'Read-only.',
    parameters: {},
    output: { schema: { oneOf: [APPS_LIST_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    execute: () => guarded(() => listApps()),
    presentCall: () => present('List apps', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'pc_app_uninstall',
    description: 'Uninstall one application by the exact id from pc_apps_list. The app moves to '
      + 'the Trash by default (recoverable); related plists and caches are reported as leftovers, '
      + 'not silently deleted. Refuses with disabled_by_config until the host enables uninstalls.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact app id from pc_apps_list.' },
    },
    output: { schema: { oneOf: [APP_UNINSTALL_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args: { id?: unknown }) {
      if (!config.enableAppUninstall) {
        return { code: 'disabled_by_config' as const, message: 'app uninstall is disabled; set pc-manager.enableAppUninstall to opt in.' }
      }
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        return { code: 'invalid_argument' as const, message: 'pc_app_uninstall requires a non-empty app id from pc_apps_list.' }
      }
      return guarded(() => uninstallApp(args.id as string, config.moveToTrash ? 'trash' : 'delete'))
    },
    presentCall: (args: unknown) => present('Uninstall app', 'other', args),
  }))

  // Mechanical confirmation gate (layer 2 of the junk-clean protocol): every
  // pc_junk_clean call asks the host's user-approval seam before executing.
  // The model cannot bypass it; a missing answerer fails closed at the
  // framework level. Requests carry no tool arguments, so the displayReason is
  // rebuilt here from the id list.
  if (config.askBeforeJunkClean) {
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name !== 'pc_junk_clean' || !config.enableJunkClean) return next()
      const args = exec.arguments as { ids?: unknown } | undefined
      const ids = Array.isArray(args?.ids)
        ? args.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      // Malformed ids never reach execution; the gate adds nothing for them.
      if (ids.length === 0) return next()
      const summary = describeJunkIds(ids, config.moveToTrash ? 'trash' : 'delete')
      return { kind: 'ask', reason: summary.en, displayReason: { en: summary.en, zh: summary.zh } }
    })
  }
}
