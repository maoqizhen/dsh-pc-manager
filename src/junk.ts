/**
 * System junk cleanup (垃圾清理). The target registry is the core safety
 * asset — which paths count as junk, why, and how safe they are — while
 * scanJunk (size walk, always dry-run) and cleanJunk (validation chain plus
 * Trash-first reclaim) are the executors. Pure node:fs, zero cordis, so the
 * module stays unit-testable outside the harness.
 * @module @deepseek-ai/dsh-pc-manager
 */

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import type { JunkCleanOutcome, JunkCleanResult, JunkItem, JunkKind, JunkScanReport, JunkSkipped } from './types.ts'
import { PcManagerError } from './types.ts'

/** Every junk kind the registry (and the tool schema) knows; closed vocabulary. */
export const JUNK_KINDS = [
  'trash', 'user-caches', 'user-logs', 'system-temp',
  'xcode-derived-data', 'xcode-archives', 'xcode-ios-device-support', 'xcode-simulator-caches',
  'simulator-unavailable-devices', 'npm-cache', 'pnpm-store', 'homebrew-cache',
  'pip-cache', 'uv-cache', 'yarn-cache', 'go-build-cache', 'go-mod-cache', 'ios-backups',
] as const satisfies readonly JunkKind[]

/** Static description of one reclaimable junk family. */
export interface JunkTarget {
  kind: JunkKind
  /** Human-readable Chinese label (a data value, not model-visible schema text). */
  label: string
  /** Scan root; limited globs (whole `*` segments only); `~` expanded via {@link resolveTargets}. */
  dir: string
  safeToClean: boolean
  /** Model-readable English: why it is junk, what deletion costs, suggested commands. */
  rationale: string
  /** whole = the root itself is one item; children = one item per first-level child. */
  granularity: 'whole' | 'children'
  /** Only report first-level children whose subtree mtime is older than this many days; omit for no filter. */
  minAgeDays?: number
  /** First-level children matching one of these rules are never listed; recorded in `skipped` instead. */
  protectedChildren?: readonly string[]
}

/**
 * Sensitive-cache protection list for `~/Library/Caches`: "caches" that hold
 * non-regenerable state (password vaults, IDE indexes, input-method lexicons,
 * VPN configs, sync clients, AI apps). Self-built — concept references only.
 */
export const PROTECTED_CHILDREN: readonly string[] = [
  // password managers / key material
  'com.1password.', 'com.agilebits.', 'com.bitwarden.', 'com.keepassx.', 'org.keepassxc.', 'com.lastpass.', 'com.dashlane.',
  // IDEs / editors (indexes and window state are not regenerable cheaply)
  'com.jetbrains.', 'com.microsoft.VSCode', 'com.visualstudio.code.', 'com.sublimetext.',
  // input methods (user lexicons live in the "cache")
  'im.rime.', 'com.sogou.inputmethod.', 'com.baidu.inputmethod.', '*.inputmethod',
  // VPN / proxy clients (profiles and WireGuard keys are not regenerable)
  'com.wireguard.', 'io.tailscale.', 'com.zerotier.', 'net.openvpn.', '*clash*', '*Clash*',
  // sync clients (local change journals)
  'com.dropbox.', 'com.getdropbox.', 'com.google.GoogleDrive', 'com.microsoft.OneDrive',
  // AI apps (may hold local sessions/models)
  'com.anthropic.claude', 'com.openai.chat', 'com.ollama.', 'page.jan.jan',
]

/**
 * Endpoint-security (EDR) prefixes for `system-temp`: deleting an enterprise
 * agent's cache triggers tamper alerts (e.g. CrowdStrike Falcon sensor), which
 * IT reads as a security incident. Protected unconditionally.
 */
export const EDR_PROTECTED_PREFIXES: readonly string[] = [
  'com.crowdstrike.', 'com.sentinelone.', 'com.sentinel-labs.', 'com.eset.',
  'com.jamf.', 'com.jamfsoftware.', 'com.paloaltonetworks.', 'com.cisco.anyconnect', 'com.cisco.secureclient',
]

/**
 * Match one first-level child name against a protection rule: a plain rule is
 * a prefix, `*suffix` a suffix, `*infix*` a substring (case-sensitive).
 */
export function matchesProtectedRule(name: string, rule: string): boolean {
  if (rule.startsWith('*') && rule.endsWith('*') && rule.length > 2) return name.includes(rule.slice(1, -1))
  if (rule.startsWith('*')) return name.endsWith(rule.slice(1))
  if (rule.endsWith('*')) return name.startsWith(rule.slice(0, -1))
  return name.startsWith(rule)
}

/**
 * macOS junk families, 18 kinds over 19 rows (`system-temp` has two roots).
 * `safeToClean: false` rows are reported by scan but refused by clean, with a
 * suggested command in the rationale.
 */
export const JUNK_TARGETS: readonly JunkTarget[] = [
  {
    kind: 'trash',
    label: '废纸篓 (~/.Trash)',
    dir: '~/.Trash',
    safeToClean: true,
    rationale: 'Files the user already discarded; emptying is the normal Trash operation. '
      + 'Whole-root granularity also keeps individual trashed file names private.',
    granularity: 'whole',
  },
  {
    kind: 'user-caches',
    label: '用户缓存 (~/Library/Caches)',
    dir: '~/Library/Caches',
    safeToClean: true,
    rationale: 'Per-app caches that apps rebuild on demand. Sensitive caches (password managers, '
      + 'IDEs, input methods, VPN, sync clients) are excluded by the protected-children list.',
    granularity: 'children',
    protectedChildren: PROTECTED_CHILDREN,
  },
  {
    kind: 'user-logs',
    label: '用户日志 (~/Library/Logs)',
    dir: '~/Library/Logs',
    safeToClean: true,
    rationale: 'Rotated logs and DiagnosticReports crash reports; recent diagnostics keep a copy in system logs.',
    granularity: 'children',
  },
  {
    kind: 'system-temp',
    label: '系统临时文件 (/private/tmp)',
    dir: '/private/tmp',
    safeToClean: true,
    rationale: 'Active temporary files must not move; only children untouched for at least 3 days are reported. '
      + 'Endpoint-security agent directories are excluded (deleting them triggers tamper alerts).',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: EDR_PROTECTED_PREFIXES,
  },
  {
    kind: 'system-temp',
    label: '系统临时缓存 (/private/var/folders)',
    dir: '/private/var/folders/*/*/C',
    safeToClean: true,
    rationale: 'Per-user temporary cache trees (the `C` subtrees of var/folders); only children untouched '
      + 'for at least 3 days are reported. Endpoint-security agent directories are excluded.',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: EDR_PROTECTED_PREFIXES,
  },
  {
    kind: 'xcode-derived-data',
    label: 'Xcode 构建产物 (DerivedData)',
    dir: '~/Library/Developer/Xcode/DerivedData',
    safeToClean: true,
    rationale: 'Build artifacts; the next build regenerates them.',
    granularity: 'children',
  },
  {
    kind: 'xcode-archives',
    label: 'Xcode 归档 (Archives)',
    dir: '~/Library/Developer/Xcode/Archives',
    safeToClean: true,
    rationale: 'Signed release archives and dSYM symbols — NOT regenerable. After deletion the Xcode '
      + 'Organizer can no longer symbolicate those historical crashes; restate this cost when confirming.',
    granularity: 'children',
  },
  {
    kind: 'xcode-ios-device-support',
    label: 'iOS 设备支持符号 (iOS DeviceSupport)',
    dir: '~/Library/Developer/Xcode/iOS DeviceSupport',
    safeToClean: true,
    rationale: 'Device symbol caches; re-downloaded when an old device reconnects.',
    granularity: 'children',
  },
  {
    kind: 'xcode-simulator-caches',
    label: '模拟器缓存 (CoreSimulator/Caches)',
    dir: '~/Library/Developer/CoreSimulator/Caches',
    safeToClean: true,
    rationale: 'Simulator runtime caches; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'simulator-unavailable-devices',
    label: '不可用模拟器 (CoreSimulator/Devices)',
    dir: '~/Library/Developer/CoreSimulator/Devices',
    safeToClean: false,
    rationale: 'Simulator device records CoreSimulator keeps metadata for; deleting raw directories '
      + 'desyncs its database. Run `xcrun simctl delete unavailable` instead.',
    granularity: 'children',
  },
  {
    kind: 'npm-cache',
    label: 'npm 缓存 (~/.npm/_cacache)',
    dir: '~/.npm/_cacache',
    safeToClean: true,
    rationale: 'Content-addressed tarball cache; `npm cache clean --force` equivalent. '
      + 'Sibling `_logs`/`_npx` are deliberately left alone.',
    granularity: 'whole',
  },
  {
    kind: 'pnpm-store',
    label: 'pnpm 内容存储 (~/Library/pnpm/store)',
    dir: '~/Library/pnpm/store',
    safeToClean: false,
    rationale: 'Hard-link source for every installed dependency; direct deletion breaks linked '
      + 'node_modules. Run `pnpm store prune` instead.',
    granularity: 'children',
  },
  {
    kind: 'homebrew-cache',
    label: 'Homebrew 下载缓存',
    dir: '~/Library/Caches/Homebrew',
    safeToClean: true,
    rationale: 'Downloaded bottles; `brew cleanup` equivalent.',
    granularity: 'children',
  },
  {
    kind: 'pip-cache',
    label: 'pip 缓存',
    dir: '~/Library/Caches/pip',
    safeToClean: true,
    rationale: 'Wheel download cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'uv-cache',
    label: 'uv 缓存',
    dir: '~/Library/Caches/uv',
    safeToClean: true,
    rationale: 'Wheel and source cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'yarn-cache',
    label: 'Yarn 缓存',
    dir: '~/Library/Caches/Yarn',
    safeToClean: true,
    rationale: 'Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).',
    granularity: 'whole',
  },
  {
    kind: 'go-build-cache',
    label: 'Go 构建缓存',
    dir: '~/Library/Caches/go-build',
    safeToClean: true,
    rationale: 'Compiled package cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'go-mod-cache',
    label: 'Go 模块缓存',
    dir: '~/go/pkg/mod/cache',
    safeToClean: true,
    rationale: 'Downloaded module cache (conservative subtree of ~/go/pkg/mod); re-downloaded on demand.',
    granularity: 'whole',
  },
  {
    kind: 'ios-backups',
    label: 'iOS 设备备份 (MobileSync/Backup)',
    dir: '~/Library/Application Support/MobileSync/Backup',
    safeToClean: true,
    rationale: 'Full iPhone/iPad backups — NOT regenerable. One subdirectory per device: restate each '
      + 'device folder by name when confirming. Trash by default keeps them recoverable.',
    granularity: 'children',
  },
]

/**
 * Kinds whose deletion costs non-regenerable data (§3.2 ✅* rows): excluded
 * from the recommended pre-selection — the UI shows them unchecked by default.
 */
const NON_REGENERABLE_KINDS: readonly JunkKind[] = ['xcode-archives', 'ios-backups']

/**
 * The pre-checked cleanup plan the dashboard presents (§16.2): every
 * safe-to-clean kind minus the non-regenerable ones, items at or above
 * 1 MiB. Safety-policy data in the registry's own league — not a Config knob.
 */
export const RECOMMENDED_PLAN: Readonly<{ kinds: readonly JunkKind[], minItemBytes: number }> = Object.freeze({
  kinds: Object.freeze(JUNK_KINDS.filter(kind => {
    const rows = JUNK_TARGETS.filter(target => target.kind === kind)
    return rows.length > 0 && rows.every(row => row.safeToClean) && !NON_REGENERABLE_KINDS.includes(kind)
  })),
  minItemBytes: 1024 * 1024,
})

/** True when the UI plan card pre-checks this item. */
export function isRecommendedItem(item: Pick<JunkItem, 'kind' | 'sizeBytes'>): boolean {
  return RECOMMENDED_PLAN.kinds.includes(item.kind) && item.sizeBytes >= RECOMMENDED_PLAN.minItemBytes
}

/**
 * Blocked system paths (defense in depth above root containment, guarding
 * against future registry misconfiguration). `~/Library/Containers` variants
 * are prefix-blocked because containers are app state, not cache; `$HOME` and
 * `~/Library` block equality only — their descendants are where junk lives.
 */
const BLOCKED_PREFIXES: readonly string[] = [
  '/System', '/usr', '/bin', '/sbin', '/private/var/db', '/private/etc', '/Library',
  '~/Library/Containers', '~/Library/Group Containers',
]

/** True when a candidate path must never be cleaned, regardless of registry contents. */
export function isBlockedPath(path: string, home: string): boolean {
  const p = normalize(path)
  const h = normalize(home)
  if (p === h || p === `${h}/Library` || p === '/Users') return true
  for (const blocked of BLOCKED_PREFIXES) {
    const b = normalize(blocked.replace(/^~(?=\/)/, h))
    if (p === b || p.startsWith(`${b}/`)) return true
  }
  if (h.startsWith('/Users/')) {
    // Other users' homes: under /Users but outside $HOME.
    if (p.startsWith('/Users/') && p !== h && !p.startsWith(`${h}/`)) return true
  } else if (p.startsWith('/Users/') || p === '/Users') {
    return true
  }
  return false
}

/** Expand `~` in every target dir; exported for tests and future filters. */
export function resolveTargets(
  targets: readonly JunkTarget[] = JUNK_TARGETS,
  home: string = homedir(),
): readonly JunkTarget[] {
  return targets.map(target => ({ ...target, dir: target.dir.replace(/^~(?=\/)/, home) }))
}

/**
 * Expand whole-segment `*` globs in target dirs (e.g. the
 * `/private/var/folders/<seg>/<seg>/C` pattern spelled with `*` segments)
 * into concrete roots via readdir. Absent or permission-denied branches are
 * skipped silently: a toolchain that is not installed simply yields no roots.
 */
export async function expandGlobs(targets: readonly JunkTarget[]): Promise<readonly JunkTarget[]> {
  const expanded: JunkTarget[] = []
  for (const target of targets) expanded.push(...await expandOneTarget(target))
  return expanded
}

async function expandOneTarget(target: JunkTarget): Promise<readonly JunkTarget[]> {
  if (!target.dir.includes('*')) return [target]
  let currents: string[] = ['/']
  for (const segment of target.dir.split('/').filter(part => part.length > 0)) {
    const next: string[] = []
    if (segment !== '*') {
      for (const current of currents) next.push(join(current, segment))
    } else {
      for (const current of currents) {
        try {
          const entries: Dirent[] = await readdir(current, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) next.push(join(current, entry.name))
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue
          throw error
        }
      }
    }
    currents = next
    if (currents.length === 0) return []
  }
  return currents.map(dir => ({ ...target, dir }))
}

/** Walk depth cap: directories deeper than this are not descended into. */
export const MAX_WALK_DEPTH = 16

/** One subtree measurement; `degraded` lists subtrees excluded from the sums. */
export interface TreeMeasure {
  sizeBytes: number
  fileCount: number
  maxMtimeMs: number | null
  degraded: Array<{ path: string, code: string }>
}

/**
 * Measure one path (file, symlink, or directory tree): lstat sizes only,
 * symlinks never followed, subtree max mtime included. EACCES/EPERM on a
 * subtree degrades that subtree (recorded + warned) instead of failing the
 * whole walk; ENOENT races are ignored. A missing or unreadable root
 * propagates the fs error to the caller. Aborting `signal` fails the walk.
 */
export async function measureTree(root: string, signal?: AbortSignal): Promise<TreeMeasure> {
  const stat: Stats = await lstat(root)
  const measure: TreeMeasure = { sizeBytes: 0, fileCount: 0, maxMtimeMs: stat.mtimeMs, degraded: [] }
  if (!stat.isDirectory()) {
    measure.sizeBytes = stat.size
    measure.fileCount = 1
    return measure
  }
  await walkDir(root, 0, measure, signal)
  return measure
}

async function walkDir(dir: string, depth: number, measure: TreeMeasure, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PcManagerError('internal_error', `junk walk aborted at ${dir}`)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    measure.degraded.push({ path: dir, code: code ?? 'unknown' })
    console.warn(`[pc-manager] junk walk degraded at ${dir}: ${code ?? error}`)
    return
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    let entryStat: Stats
    try {
      entryStat = await lstat(entryPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      measure.degraded.push({ path: entryPath, code: code ?? 'unknown' })
      console.warn(`[pc-manager] junk walk degraded at ${entryPath}: ${code ?? error}`)
      continue
    }
    measure.maxMtimeMs = Math.max(measure.maxMtimeMs ?? entryStat.mtimeMs, entryStat.mtimeMs)
    if (entryStat.isDirectory()) {
      if (depth + 1 < MAX_WALK_DEPTH) await walkDir(entryPath, depth + 1, measure, signal)
      continue
    }
    measure.sizeBytes += entryStat.size
    measure.fileCount += 1
  }
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

function assertMacOS(): void {
  if (platform() !== 'darwin') {
    throw new PcManagerError('unsupported_platform', 'junk scan/clean only support macOS hosts.')
  }
}

function throwIfAborted(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted) throw new PcManagerError('internal_error', `junk ${where} aborted`)
}

/** Options for {@link scanJunk}; all optional. */
export interface ScanJunkOptions {
  /** Restrict the scan to these kinds; omit to scan every registered target. */
  kinds?: readonly JunkKind[]
  /** Omit items smaller than this many bytes (default 0, keep everything). */
  minItemBytes?: number
  /** Abort the walk; aborting fails the whole scan. */
  signal?: AbortSignal
}

/**
 * Enumerate reclaimable junk as a grouped, per-item report. Always a dry run:
 * scanning never writes or deletes anything. Missing roots yield no items;
 * permission-degraded subtrees and protected children are reported in
 * `skipped`; `totalBytes` always equals the sum of the listed items.
 */
export async function scanJunk(
  options: ScanJunkOptions = {},
  targets: readonly JunkTarget[] = resolveTargets(),
): Promise<JunkScanReport> {
  assertMacOS()
  throwIfAborted(options.signal, 'scan')
  const selected = options.kinds === undefined
    ? targets
    : targets.filter(target => options.kinds?.includes(target.kind))
  const expanded = await expandGlobs(selected)
  // Overlap exclusion (§3.4): a first-level child that IS another registry
  // root belongs to its own kind; listing it here would double-count.
  const rootDirs = new Set(expanded.map(target => target.dir))
  const results = await mapLimit(expanded, 4, target => scanOneTarget(target, rootDirs, options.signal))
  const minItemBytes = options.minItemBytes ?? 0
  const items = results.flatMap(result => result.items)
    .filter(item => item.sizeBytes >= minItemBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    skipped: results.flatMap(result => result.skipped),
    scannedAt: new Date().toISOString(),
  }
}

async function scanOneTarget(
  target: JunkTarget,
  rootDirs: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<{ items: JunkItem[], skipped: JunkSkipped[] }> {
  const items: JunkItem[] = []
  const skipped: JunkSkipped[] = []
  let rootStat: Stats
  try {
    rootStat = await lstat(target.dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Conditional existence: an absent root (toolchain not installed) is not junk.
    if (code !== 'ENOENT') {
      skipped.push({ path: target.dir, reason: `walk failed: ${code ?? error}` })
      console.warn(`[pc-manager] junk walk degraded at ${target.dir}: ${code ?? error}`)
    }
    return { items, skipped }
  }
  if (target.granularity === 'whole') {
    const measure = await measureWithSkipped(target.dir, skipped, signal)
    if (measure !== null) {
      items.push({
        id: `${target.kind}:${target.dir}`,
        kind: target.kind,
        label: target.label,
        path: target.dir,
        sizeBytes: measure.sizeBytes,
        fileCount: measure.fileCount,
        safeToClean: target.safeToClean,
        rationale: target.rationale,
        lastModifiedAt: new Date(rootStat.mtimeMs).toISOString(),
      })
    }
    return { items, skipped }
  }
  if (!rootStat.isDirectory()) return { items, skipped }
  let entries: Dirent[]
  try {
    entries = await readdir(target.dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    skipped.push({ path: target.dir, reason: `walk failed: ${code ?? error}` })
    console.warn(`[pc-manager] junk walk degraded at ${target.dir}: ${code ?? error}`)
    return { items, skipped }
  }
  for (const entry of entries) {
    const childPath = join(target.dir, entry.name)
    const matchedRule = target.protectedChildren?.find(rule => matchesProtectedRule(entry.name, rule))
    if (matchedRule !== undefined) {
      skipped.push({ path: childPath, reason: `protected child (rule: ${matchedRule})` })
      continue
    }
    if (rootDirs.has(childPath)) continue
    const measure = await measureWithSkipped(childPath, skipped, signal)
    if (measure === null) continue
    if (target.minAgeDays !== undefined && measure.maxMtimeMs !== null
      && measure.maxMtimeMs > Date.now() - target.minAgeDays * 86_400_000) continue
    items.push({
      id: `${target.kind}:${childPath}`,
      kind: target.kind,
      label: entry.name,
      path: childPath,
      sizeBytes: measure.sizeBytes,
      fileCount: measure.fileCount,
      safeToClean: target.safeToClean,
      rationale: target.rationale,
      lastModifiedAt: measure.maxMtimeMs === null ? null : new Date(measure.maxMtimeMs).toISOString(),
    })
  }
  return { items, skipped }
}

/** Measure one path, translating failures into `skipped` records; null = no item. */
async function measureWithSkipped(
  path: string,
  skipped: JunkSkipped[],
  signal: AbortSignal | undefined,
): Promise<TreeMeasure | null> {
  let measure: TreeMeasure
  try {
    measure = await measureTree(path, signal)
  } catch (error) {
    throwIfAborted(signal, 'scan')
    const code = (error as NodeJS.ErrnoException).code
    // A child that vanished between readdir and lstat was never really there.
    if (code !== 'ENOENT') {
      skipped.push({ path, reason: `walk failed: ${code ?? error}` })
      console.warn(`[pc-manager] junk walk degraded at ${path}: ${code ?? error}`)
    }
    return null
  }
  // A root that itself cannot be read yields no item: a "0 bytes" reading is
  // unknown size, not empty.
  const rootDegraded = measure.degraded.find(degraded => degraded.path === path)
  if (rootDegraded !== undefined) {
    skipped.push({ path, reason: `walk failed: ${rootDegraded.code}` })
    return null
  }
  for (const degraded of measure.degraded) {
    skipped.push({ path: degraded.path, reason: `walk degraded: ${degraded.code}` })
  }
  return measure
}

/**
 * Parse one junk id `<kind>:<absolute path>`; null when the kind is outside
 * the vocabulary or the path is not absolute.
 */
export function parseJunkId(id: string): { kind: JunkKind, path: string } | null {
  const separator = id.indexOf(':')
  if (separator <= 0) return null
  const kind = id.slice(0, separator) as JunkKind
  const path = id.slice(separator + 1)
  if (!(JUNK_KINDS as readonly string[]).includes(kind)) return null
  if (!path.startsWith('/')) return null
  return { kind, path }
}

/** Strict descendant check after normalization; equality is not "under". */
function isStrictlyUnder(path: string, root: string): boolean {
  const p = normalize(path)
  const r = normalize(root)
  if (p === r) return false
  return p.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * Layer 1–5 structural validation over the id list (§4.2). Children kinds
 * accept only strict descendants of their roots (empty-name collapse defense);
 * whole kinds accept exactly their root. Any failure rejects the whole batch
 * with `invalid_argument` / `unsafe_target` — zero deletions.
 */
export async function validateJunkIds(
  ids: readonly string[],
  expanded: readonly JunkTarget[],
  home: string,
): Promise<void> {
  for (const id of ids) {
    const parsed = parseJunkId(id)
    if (parsed === null) {
      throw new PcManagerError('invalid_argument', `invalid junk id: ${JSON.stringify(id)}`)
    }
    const { kind, path } = parsed
    const targetsOfKind = expanded.filter(target => target.kind === kind)
    if (targetsOfKind.length === 0) {
      throw new PcManagerError('invalid_argument', `unregistered junk kind in id: ${id}`)
    }
    const withinLiteral = targetsOfKind.some(target =>
      target.granularity === 'whole' ? normalize(path) === normalize(target.dir) : isStrictlyUnder(path, target.dir))
    if (!withinLiteral) {
      throw new PcManagerError('invalid_argument', `path escapes its ${kind} root: ${id}`)
    }
    // Blocked paths are refused on the literal path regardless of any later
    // realpath outcome, so a vanished target cannot slip past the list.
    if (isBlockedPath(path, home)) {
      throw new PcManagerError('unsafe_target', `refusing blocked system path: ${id}`)
    }
    // Realpath defense: a symlinked ancestor may redirect the literal path
    // outside the root while the literal check still passes. A vanished
    // target or root is runtime state (per-item not_found), not a structural
    // failure, so realpath errors here fall back to the literal verdict.
    let realPath: string | null = null
    try {
      realPath = await realpath(normalize(path))
    } catch {
      realPath = null
    }
    if (realPath !== null) {
      let rootsResolved = 0
      let withinReal = false
      for (const target of targetsOfKind) {
        let realRoot: string
        try {
          realRoot = await realpath(target.dir)
        } catch { continue /* root vanished; literal verdict stands */ }
        rootsResolved += 1
        const within = target.granularity === 'whole' ? realPath === realRoot : isStrictlyUnder(realPath, realRoot)
        if (within) {
          withinReal = true
          break
        }
      }
      if (rootsResolved > 0 && !withinReal) {
        throw new PcManagerError('invalid_argument', `realpath escapes its ${kind} root (symlink redirect?): ${id}`)
      }
      if (isBlockedPath(realPath, home)) {
        throw new PcManagerError('unsafe_target', `refusing blocked system path: ${id}`)
      }
    }
    if (targetsOfKind.some(target => target.safeToClean === false)) {
      const unsafe = targetsOfKind.find(target => target.safeToClean === false)
      throw new PcManagerError('unsafe_target', `${kind} must not be cleaned directly; ${unsafe?.rationale ?? ''}`)
    }
  }
}

/** Absolute path of the system trash utility (macOS 15+); called without PATH lookup. */
export const TRASH_BIN = '/usr/bin/trash'
/** Timeout for one trash(8) invocation. */
const TRASH_TIMEOUT_MS = 30_000

/** Injectable indirections so tests can exercise every trash tier offline. */
export interface CleanIo {
  /** Tier 1: hand paths to the system trash utility. */
  runTrashCommand(paths: readonly string[]): Promise<void>
  /** Tier 2 primitive; tests inject an EXDEV-throwing rename to reach tier 3. */
  rename(from: string, to: string): Promise<void>
}

/** Options for {@link cleanJunk}; `home` and `io` are test seams. */
export interface CleanJunkOptions {
  signal?: AbortSignal
  /** Overrides the home directory backing `~/.Trash` (default os.homedir()). */
  home?: string
  /** Partial override of the fs/exec indirections. */
  io?: Partial<CleanIo>
}

const runFile = promisify(execFile)

const defaultIo: CleanIo = {
  runTrashCommand: async paths => {
    await runFile(TRASH_BIN, [...paths], { timeout: TRASH_TIMEOUT_MS })
  },
  rename: (from, to) => rename(from, to),
}

async function canExecute(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Reject a `~/.Trash` that is not a directory, not ours, or writable by
 * group/others — a world-writable trash destination would let anything
 * intercept "recovered" files.
 */
async function ensureSafeTrashDir(trashDir: string): Promise<void> {
  let stat: Stats
  try {
    stat = await lstat(trashDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(trashDir, { mode: 0o700 })
    return
  }
  if (!stat.isDirectory()) throw new Error(`${trashDir} is not a directory`)
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid !== uid) throw new Error(`${trashDir} is not owned by the current user`)
  if ((stat.mode & 0o022) !== 0) throw new Error(`${trashDir} is group- or other-writable`)
}

/** First free `name`, `name 2`, `name 3`, … inside the trash directory. */
async function reserveTrashName(trashDir: string, name: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = join(trashDir, attempt === 1 ? name : `${name} ${attempt}`)
    try {
      await lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
}

async function moveToTrash(path: string, home: string, io: CleanIo, trashBinUsable: boolean): Promise<void> {
  if (trashBinUsable) {
    try {
      await io.runTrashCommand([path])
      return
    } catch (error) {
      console.warn(`[pc-manager] ${TRASH_BIN} failed, falling back to rename: ${String(error)}`)
    }
  }
  const trashDir = join(home, '.Trash')
  await ensureSafeTrashDir(trashDir)
  const dest = await reserveTrashName(trashDir, basename(path))
  try {
    await io.rename(path, dest)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  // Cross-volume last resort: copy in, verify the copy landed, then remove
  // the source. A failure before the rm leaves the source untouched.
  await cp(path, dest, { recursive: true, force: false })
  await lstat(dest)
  await rm(path, { recursive: true, force: false })
}

/** Remove every child of `dir`, keeping the directory itself. */
async function emptyDirectory(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: false })
  }
}

/**
 * Reclaim the selected junk items. All ids pass the structural validation
 * chain first — one invalid id rejects the whole batch with zero deletions.
 * Per item: vanished targets report `not_found`; re-measure failure skips the
 * item untouched; trash mode tiers through /usr/bin/trash, rename into
 * ~/.Trash, and cross-volume copy+remove. The `trash` kind empties its
 * children in place (moving entries of the Trash back into the Trash would be
 * a no-op). Failures surface per-item, never silently.
 */
export async function cleanJunk(
  ids: readonly string[],
  mode: 'trash' | 'delete',
  targets: readonly JunkTarget[] = resolveTargets(),
  options: CleanJunkOptions = {},
): Promise<JunkCleanResult> {
  assertMacOS()
  if (ids.length === 0) {
    throw new PcManagerError('invalid_argument', 'cleanJunk requires at least one junk item id.')
  }
  const home = options.home ?? homedir()
  const io: CleanIo = { ...defaultIo, ...options.io }
  const expanded = await expandGlobs(targets)
  await validateJunkIds(ids, expanded, home)

  const trashBinUsable = mode === 'trash' && (options.io?.runTrashCommand !== undefined || await canExecute(TRASH_BIN))
  const outcomes: JunkCleanOutcome[] = []
  for (const id of ids) {
    throwIfAborted(options.signal, 'clean')
    const parsed = parseJunkId(id)
    if (parsed === null) {
      outcomes.push({ id, reclaimedBytes: 0, error: 'invalid_argument' })
      continue
    }
    const { kind, path } = parsed
    let bytes: number
    try {
      const measure = await measureTree(path, options.signal)
      // 量不准不删: a partially-readable item has an unknown size and is
      // refused untouched rather than reclaimed on a wrong number.
      if (measure.degraded.length > 0) {
        outcomes.push({
          id,
          reclaimedBytes: 0,
          error: `measure_failed: incomplete measurement (${measure.degraded.length} permission-degraded subtrees)`,
        })
        continue
      }
      bytes = measure.sizeBytes
    } catch (error) {
      throwIfAborted(options.signal, 'clean')
      const code = (error as NodeJS.ErrnoException).code
      outcomes.push({ id, reclaimedBytes: 0, error: code === 'ENOENT' ? 'not_found' : `measure_failed: ${code ?? error}` })
      continue
    }
    try {
      if (kind === 'trash') {
        // Emptying the Trash is the destructive act itself; its contents have
        // no further trash to go to. The directory itself stays in place.
        await emptyDirectory(path)
      } else if (mode === 'delete') {
        await rm(path, { recursive: true, force: false })
      } else {
        await moveToTrash(path, home, io, trashBinUsable)
      }
      outcomes.push({ id, reclaimedBytes: bytes })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcomes.push({ id, reclaimedBytes: 0, error: `${mode}_failed: ${message}` })
    }
  }
  return {
    outcomes,
    totalReclaimedBytes: outcomes.reduce((sum, outcome) => sum + outcome.reclaimedBytes, 0),
    mode,
    cleanedAt: new Date().toISOString(),
  }
}

/**
 * Bilingual approval summary for a batch of ids: item count, per-kind
 * distribution, and the destination. Pure — safe to call from the
 * pre-execute listener.
 */
export function describeJunkIds(ids: readonly string[], mode: 'trash' | 'delete'): { en: string, zh: string } {
  const counts = new Map<string, number>()
  let unknown = 0
  for (const id of ids) {
    const kind = parseJunkId(id)?.kind
    if (kind === undefined) unknown += 1
    else counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([kind, count]) => `${kind} ×${count}`)
  if (unknown > 0) parts.push(`unrecognized ×${unknown}`)
  const distribution = parts.join(', ')
  const noun = ids.length === 1 ? 'item' : 'items'
  const en = mode === 'trash'
    ? `Clean ${ids.length} ${noun} (${distribution}) → move to Trash. Recoverable until the Trash is emptied.`
    : `Clean ${ids.length} ${noun} (${distribution}) → permanent deletion. Not recoverable.`
  const zh = mode === 'trash'
    ? `清理 ${ids.length} 项（${distribution}）→ 移入废纸篓，清空前可恢复。`
    : `清理 ${ids.length} 项（${distribution}）→ 永久删除，不可恢复。`
  return { en, zh }
}
