/**
 * System junk cleanup (垃圾清理) for macOS, Linux, and Windows hosts. The
 * target registries (one per platform) are the core safety asset — which paths
 * count as junk, why, and how safe they are — while scanJunk (size walk,
 * always dry-run) and cleanJunk (validation chain plus Trash-first reclaim)
 * are the executors. Pure node:fs, zero cordis, so the module stays
 * unit-testable outside the harness.
 * @module @deepseek-ai/dsh-pc-manager
 */

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { JunkCleanOutcome, JunkCleanResult, JunkItem, JunkKind, JunkScanReport, JunkSkipped } from './types.ts'
import { PcManagerError } from './types.ts'
import { PS_ARGV, PS_PREAMBLE, resolvePowershell } from './win32.ts'

/**
 * Path-literal flavor. The registries carry POSIX (macOS/Linux) and Windows
 * paths side by side, and the test suite pins all three registries from any
 * host — so every transform picks its flavor from the literal itself rather
 * than from the host's `node:path` default, which would rewrite a POSIX
 * fixture into `\Users\t\.Trash` when the suite runs on Windows.
 */
export type PathFlavor = 'win32' | 'posix'

/** Flavor of one literal: a drive-absolute or UNC path is Windows, else POSIX. */
export function pathFlavor(path: string): PathFlavor {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path) ? 'win32' : 'posix'
}

/** The `node:path` face for a flavor. */
const apiFor = (flavor: PathFlavor): typeof posix => flavor === 'win32' ? win32 : posix

/** Windows filesystems are case-insensitive; POSIX ones are not. */
const foldCase = (flavor: PathFlavor, value: string): string =>
  flavor === 'win32' ? value.toLowerCase() : value

/**
 * Normalize with the literal's own flavor, dropping a trailing separator
 * (except at a root). The strip is a safety property, not cosmetics: without
 * it `user-caches:/Users/x/.cache/` normalizes to the root itself yet still
 * satisfies the "strictly under the root" test that guards children-kind
 * deletion, which would let a trailing slash empty a whole registry root.
 */
export function normalizePath(path: string): string {
  return normalizeLiteral(apiFor(pathFlavor(path)), path)
}

/** Normalization body, shared by the flavor-detecting entry point and the
 * flavor-injected helpers below. */
function normalizeLiteral(api: typeof posix, value: string): string {
  const normalized = api.normalize(value)
  const root = api.parse(normalized).root
  return normalized.length > root.length && normalized.endsWith(api.sep)
    ? normalized.slice(0, -1)
    : normalized
}

/** Join with the base literal's flavor, so `/Users/t` + `.Trash` stays POSIX
 * even on a Windows host, and a Windows base keeps its backslashes. */
export function joinPath(base: string, ...parts: string[]): string {
  return apiFor(pathFlavor(base)).join(base, ...parts)
}

/** True when the literal is absolute in its own flavor (POSIX `/…`, Windows
 * `C:\…`/`C:/…`, or a UNC share). */
export function isAbsolutePath(path: string): boolean {
  return apiFor(pathFlavor(path)).isAbsolute(path)
}

/** Basename in the literal's own flavor (`C:\a\b` → `b` on any host). */
export function basenamePath(path: string): string {
  return apiFor(pathFlavor(path)).basename(path)
}

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
 * Sensitive-cache protection list for macOS `~/Library/Caches`: "caches" that
 * hold non-regenerable state (password vaults, IDE indexes, input-method
 * lexicons, VPN configs, sync clients, AI apps). Self-built — concept
 * references only.
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
 * The same protection concept for Linux `~/.cache`, where directories are
 * named after the app (XDG convention) instead of a reverse-DNS bundle id.
 * Over-blocking is the safe direction: rules are prefixes.
 */
export const LINUX_PROTECTED_CHILDREN: readonly string[] = [
  // password managers / key material
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane',
  // IDEs / editors (indexes and window state are not regenerable cheaply)
  'jetbrains', 'vscode', 'Code', 'sublime-text', 'sublime',
  // input methods (user lexicons live in the "cache")
  'fcitx', 'ibus', 'rime',
  // VPN / proxy clients (profiles and keys are not regenerable)
  'clash', 'Clash', 'tailscale', 'Tailscale', 'openvpn', 'OpenVPN',
  'wireguard', 'WireGuard', 'zerotier', 'mullvad',
  // sync clients (local change journals)
  'dropbox', 'Dropbox', 'onedrive', 'OneDrive', 'google-drive', 'nextcloud', 'syncthing',
  // AI apps (may hold local sessions/models)
  'ollama', 'jan', 'lm-studio', 'claude', 'Claude',
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
 * Linux `system-temp` protections: live systemd/snap private dirs under /tmp
 * and /var/tmp belong to running services, and Linux EDR agents (falcon,
 * sentinelone, defender…) trip tamper alerts like their macOS peers.
 */
export const LINUX_TEMP_PROTECTED: readonly string[] = [
  // live service state: deleting these breaks running services
  'systemd-private-', 'snap-private-tmp',
  // endpoint-security agents (tamper alerts)
  'falcon', 'crowdstrike', 'sentinelone', 's1agent', 'carbonblack', 'cb-defense',
  'mde', 'sophos', 'defender',
]

/**
 * Windows `system-temp` protections. `%TEMP%` and `%SystemRoot%\Temp` are
 * shared by every process on the box, so live installer scaffolding is
 * skipped (deleting a directory another process is using fails or breaks the
 * install) and endpoint-security agents are protected for the same
 * tamper-alert reason as the macOS/Linux lists.
 */
export const WINDOWS_TEMP_PROTECTED: readonly string[] = [
  // endpoint-security / antivirus agents (tamper alerts, quarantined samples)
  'CrowdStrike', 'CSFalcon', 'SentinelOne', 'Sentinel', 'Sophos', 'Tanium', 'CarbonBlack', 'CbDefense',
  'mde', 'MsMpEng', 'MpCmdRun', 'MpEngine', 'Defender', 'avast', 'AVG', 'ESET', 'Kaspersky',
  // live installer / servicing scaffolding
  'scoped_dir', 'chrome_installer', 'VSIXInstaller', 'Microsoft Visual Studio', 'Roslyn',
]

/**
 * Well-known Windows account SIDs whose Recycle Bin folders are never the
 * current user's: LocalSystem, LocalService, and NetworkService. Other users'
 * SID folders are not listed — they are unreadable from this account and
 * degrade to `skipped` through the walk instead.
 */
export const WINDOWS_SYSTEM_SIDS: readonly string[] = ['S-1-5-18', 'S-1-5-19', 'S-1-5-20']

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
export const JUNK_TARGETS_DARWIN: readonly JunkTarget[] = [
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
 * Linux junk families (XDG layout), 11 kinds over 12 rows (`system-temp` has
 * two roots). macOS-only kinds (user-logs, the Xcode/simulator families,
 * ios-backups) have no Linux rows: absent roots never produce items anyway,
 * and the kind vocabulary stays closed for schema stability. Command-shaped
 * reclaim targets (apt autoremove, journalctl vacuum, snap old revisions,
 * flatpak --unused, docker prune) are deliberately NOT rows — the registry
 * only reclaims paths; those live in the README as suggested commands.
 */
export const JUNK_TARGETS_LINUX: readonly JunkTarget[] = [
  {
    kind: 'trash',
    label: '回收站 (~/.local/share/Trash)',
    dir: '~/.local/share/Trash',
    safeToClean: true,
    rationale: 'Files the user already discarded (freedesktop trash); emptying is the normal trash '
      + 'operation. Whole-root granularity also keeps individual trashed file names private.',
    granularity: 'whole',
  },
  {
    kind: 'user-caches',
    label: '用户缓存 (~/.cache)',
    dir: '~/.cache',
    safeToClean: true,
    rationale: 'XDG per-app caches that apps rebuild on demand (including ~/.cache/thumbnails, which '
      + 'the file manager regenerates). Sensitive caches (password managers, IDEs, input methods, VPN, '
      + 'sync clients) are excluded by the protected-children list.',
    granularity: 'children',
    protectedChildren: LINUX_PROTECTED_CHILDREN,
  },
  {
    kind: 'system-temp',
    label: '系统临时文件 (/tmp)',
    dir: '/tmp',
    safeToClean: true,
    rationale: 'Active temporary files must not move; only children untouched for at least 3 days are '
      + 'reported. systemd private dirs (systemd-private-*) and snap-private-tmp belong to running '
      + 'services and are excluded, as are endpoint-security agent directories (deleting them triggers '
      + 'tamper alerts).',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: LINUX_TEMP_PROTECTED,
  },
  {
    kind: 'system-temp',
    label: '系统临时文件 (/var/tmp)',
    dir: '/var/tmp',
    safeToClean: true,
    rationale: 'Persistent temporary files (survive reboots by convention); only children untouched '
      + 'for at least 3 days are reported, with the same live-service and endpoint-security exclusions '
      + 'as /tmp.',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: LINUX_TEMP_PROTECTED,
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
    label: 'pnpm 内容存储 (~/.local/share/pnpm/store)',
    dir: '~/.local/share/pnpm/store',
    safeToClean: false,
    rationale: 'Hard-link source for every installed dependency; direct deletion breaks linked '
      + 'node_modules. Run `pnpm store prune` instead.',
    granularity: 'children',
  },
  {
    kind: 'homebrew-cache',
    label: 'Homebrew 下载缓存 (~/.cache/Homebrew)',
    dir: '~/.cache/Homebrew',
    safeToClean: true,
    rationale: 'Downloaded bottles (Linuxbrew); `brew cleanup` equivalent.',
    granularity: 'children',
  },
  {
    kind: 'pip-cache',
    label: 'pip 缓存 (~/.cache/pip)',
    dir: '~/.cache/pip',
    safeToClean: true,
    rationale: 'Wheel download cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'uv-cache',
    label: 'uv 缓存 (~/.cache/uv)',
    dir: '~/.cache/uv',
    safeToClean: true,
    rationale: 'Wheel and source cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'yarn-cache',
    label: 'Yarn 缓存 (~/.cache/yarn)',
    dir: '~/.cache/yarn',
    safeToClean: true,
    rationale: 'Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).',
    granularity: 'whole',
  },
  {
    kind: 'go-build-cache',
    label: 'Go 构建缓存 (~/.cache/go-build)',
    dir: '~/.cache/go-build',
    safeToClean: true,
    rationale: 'Compiled package cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'go-mod-cache',
    label: 'Go 模块缓存 (~/go/pkg/mod/cache)',
    dir: '~/go/pkg/mod/cache',
    safeToClean: true,
    rationale: 'Downloaded module cache (conservative subtree of ~/go/pkg/mod); re-downloaded on demand.',
    granularity: 'whole',
  },
]

/**
 * Windows junk families, 18 rows over 11 kinds. Roots are spelled with
 * `%VAR%` placeholders (expanded by {@link resolveTargets}) because a Windows
 * profile is relocatable: `%TEMP%`, `%LOCALAPPDATA%`, `%SystemRoot%`, and
 * `%USERPROFILE%` follow the account and the system drive.
 *
 * Two deliberate differences from the macOS/Linux registries:
 *
 * - There is **no umbrella `user-caches` row**. `%LOCALAPPDATA%` is not a
 *   cache directory the way `~/.cache` or `~/Library/Caches` is — it mixes
 *   real per-app state (`Packages\*\LocalState`, `Microsoft\Credentials`,
 *   browser profiles) with caches, and no protection list covers that
 *   reliably. Only individually known-safe cache roots are registered.
 * - Command-shaped reclaim (Windows Update's `SoftwareDistribution\Download`,
 *   Delivery Optimization, `WinSxS` component cleanup) is NOT a row, matching
 *   the macOS/Linux stance: those run through DISM/Storage Sense and live in
 *   the README as suggested commands.
 */
export const JUNK_TARGETS_WIN32: readonly JunkTarget[] = [
  {
    kind: 'trash',
    label: '回收站 ($Recycle.Bin)',
    dir: '%SystemDrive%\\$Recycle.Bin',
    safeToClean: true,
    rationale: 'Files the user already discarded. Windows keeps one folder per account SID; this '
      + 'account\'s folder is emptied in place (the local Recycle Bin operation). LocalSystem/'
      + 'LocalService/NetworkService folders are excluded, and another account\'s folder is '
      + 'unreadable and reported as skipped instead.',
    granularity: 'children',
    protectedChildren: WINDOWS_SYSTEM_SIDS,
  },
  {
    kind: 'system-temp',
    label: '用户临时文件 (%TEMP%)',
    dir: '%TEMP%',
    safeToClean: true,
    rationale: 'Per-user temporary files; apps recreate them on demand. Only children untouched for '
      + 'at least 3 days are reported, and live installer scaffolding plus endpoint-security agent '
      + 'directories are excluded (deleting them breaks a running install or trips tamper alerts).',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: WINDOWS_TEMP_PROTECTED,
  },
  {
    kind: 'system-temp',
    label: '系统临时文件 (%SystemRoot%\\Temp)',
    dir: '%SystemRoot%\\Temp',
    safeToClean: true,
    rationale: 'Machine-wide temporary files. Only children untouched for at least 3 days are '
      + 'reported, with the same live-installer and endpoint-security exclusions as %TEMP%. Writing '
      + 'here generally needs an elevated process, so expect unreadable children to be skipped.',
    granularity: 'children',
    minAgeDays: 3,
    protectedChildren: WINDOWS_TEMP_PROTECTED,
  },
  {
    kind: 'user-logs',
    label: '错误报告存档 (%LOCALAPPDATA%\\…\\WER\\ReportArchive)',
    dir: '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive',
    safeToClean: true,
    rationale: 'Windows Error Reporting crash archives; diagnostic copies that no longer serve a '
      + 'purpose once reported. Regenerated only by new crashes.',
    granularity: 'children',
  },
  {
    kind: 'user-logs',
    label: '错误报告队列 (%LOCALAPPDATA%\\…\\WER\\ReportQueue)',
    dir: '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue',
    safeToClean: true,
    rationale: 'Windows Error Reporting entries still queued for upload; reports already sent live '
      + 'in the archive. Regenerated only by new crashes.',
    granularity: 'children',
  },
  {
    kind: 'user-logs',
    label: '崩溃转储 (%LOCALAPPDATA%\\CrashDumps)',
    dir: '%LOCALAPPDATA%\\CrashDumps',
    safeToClean: true,
    rationale: 'Post-mortem process dumps written by WER; useful only while debugging a crash that '
      + 'is being investigated right now.',
    granularity: 'children',
  },
  {
    kind: 'user-caches',
    label: 'WinINet 缓存 (%LOCALAPPDATA%\\…\\INetCache)',
    dir: '%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache',
    safeToClean: true,
    rationale: 'The system-wide WinINet download cache shared by apps that use the Windows HTTP '
      + 'stack; refetched on demand. (Cookies live in the sibling INetCookies tree and are not '
      + 'touched.)',
    granularity: 'children',
  },
  {
    kind: 'user-caches',
    label: 'DirectX 着色器缓存 (%LOCALAPPDATA%\\D3DSCache)',
    dir: '%LOCALAPPDATA%\\D3DSCache',
    safeToClean: true,
    rationale: 'Compiled shader cache; games recompile it on first launch, costing a one-time '
      + 'stutter rather than data.',
    granularity: 'children',
  },
  {
    kind: 'user-caches',
    label: 'NVIDIA 着色器缓存 (%LOCALAPPDATA%\\NVIDIA\\DXCache)',
    dir: '%LOCALAPPDATA%\\NVIDIA\\DXCache',
    safeToClean: true,
    rationale: 'DirectX shader cache written by the NVIDIA driver; rebuilt on demand.',
    granularity: 'children',
  },
  {
    kind: 'user-caches',
    label: 'NVIDIA OpenGL 缓存 (%LOCALAPPDATA%\\NVIDIA\\GLCache)',
    dir: '%LOCALAPPDATA%\\NVIDIA\\GLCache',
    safeToClean: true,
    rationale: 'OpenGL shader cache written by the NVIDIA driver; rebuilt on demand.',
    granularity: 'children',
  },
  {
    kind: 'user-caches',
    label: '远程桌面缓存 (%LOCALAPPDATA%\\…\\Terminal Server Client\\Cache)',
    dir: '%LOCALAPPDATA%\\Microsoft\\Terminal Server Client\\Cache',
    safeToClean: true,
    rationale: 'Remote Desktop bitmap cache; rebuilt as the session redraws.',
    granularity: 'children',
  },
  {
    kind: 'npm-cache',
    label: 'npm 缓存 (%LOCALAPPDATA%\\npm-cache)',
    dir: '%LOCALAPPDATA%\\npm-cache',
    safeToClean: true,
    rationale: 'Content-addressed tarball cache on Windows (npm\'s `_cacache` equivalent); '
      + '`npm cache clean --force` equivalent.',
    granularity: 'whole',
  },
  {
    kind: 'pnpm-store',
    label: 'pnpm 内容存储 (%LOCALAPPDATA%\\pnpm\\store)',
    dir: '%LOCALAPPDATA%\\pnpm\\store',
    safeToClean: false,
    rationale: 'Hard-link source for every installed dependency; direct deletion breaks linked '
      + 'node_modules. Run `pnpm store prune` instead.',
    granularity: 'children',
  },
  {
    kind: 'pip-cache',
    label: 'pip 缓存 (%LOCALAPPDATA%\\pip\\Cache)',
    dir: '%LOCALAPPDATA%\\pip\\Cache',
    safeToClean: true,
    rationale: 'Wheel download cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'uv-cache',
    label: 'uv 缓存 (%LOCALAPPDATA%\\uv\\cache)',
    dir: '%LOCALAPPDATA%\\uv\\cache',
    safeToClean: true,
    rationale: 'Wheel and source cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'yarn-cache',
    label: 'Yarn 缓存 (%LOCALAPPDATA%\\Yarn\\Cache)',
    dir: '%LOCALAPPDATA%\\Yarn\\Cache',
    safeToClean: true,
    rationale: 'Yarn 1.x package cache; `yarn cache clean` equivalent (on berry installs run that command).',
    granularity: 'whole',
  },
  {
    kind: 'go-build-cache',
    label: 'Go 构建缓存 (%LOCALAPPDATA%\\go-build)',
    dir: '%LOCALAPPDATA%\\go-build',
    safeToClean: true,
    rationale: 'Compiled package cache; rebuilt on demand.',
    granularity: 'whole',
  },
  {
    kind: 'go-mod-cache',
    label: 'Go 模块缓存 (%USERPROFILE%\\go\\pkg\\mod\\cache)',
    dir: '%USERPROFILE%\\go\\pkg\\mod\\cache',
    safeToClean: true,
    rationale: 'Downloaded module cache (conservative subtree of %USERPROFILE%\\go\\pkg\\mod); '
      + 're-downloaded on demand.',
    granularity: 'whole',
  },
]

/** Every registry, keyed by the platform that owns it. */
export const JUNK_TARGETS_BY_PLATFORM: Readonly<Record<string, readonly JunkTarget[]>> = {
  darwin: JUNK_TARGETS_DARWIN,
  linux: JUNK_TARGETS_LINUX,
  win32: JUNK_TARGETS_WIN32,
}

/** The current platform's registry (the safety asset the tools scan); an
 * unknown platform falls back to the macOS registry so a scan on an
 * unsupported host still enumerates something reviewable. */
export const JUNK_TARGETS: readonly JunkTarget[] =
  JUNK_TARGETS_BY_PLATFORM[platform()] ?? JUNK_TARGETS_DARWIN

/**
 * Kinds whose deletion costs non-regenerable data (§3.2 ✅* rows): excluded
 * from the recommended pre-selection — the UI shows them unchecked by default.
 */
const NON_REGENERABLE_KINDS: readonly JunkKind[] = ['xcode-archives', 'ios-backups']

/**
 * The pre-checked cleanup plan for one registry (§16.2): every safe-to-clean
 * kind minus the non-regenerable ones, items at or above 1 MiB. Safety-policy
 * data in the registry's own league — not a Config knob.
 */
export function computeRecommendedPlan(
  targets: readonly JunkTarget[] = JUNK_TARGETS,
): Readonly<{ kinds: readonly JunkKind[], minItemBytes: number }> {
  const kinds = JUNK_KINDS.filter(kind => {
    const rows = targets.filter(target => target.kind === kind)
    return rows.length > 0 && rows.every(row => row.safeToClean) && !NON_REGENERABLE_KINDS.includes(kind)
  })
  return Object.freeze({ kinds: Object.freeze(kinds), minItemBytes: 1024 * 1024 })
}

/** The current platform's pre-checked cleanup plan. */
export const RECOMMENDED_PLAN: Readonly<{ kinds: readonly JunkKind[], minItemBytes: number }> =
  computeRecommendedPlan()

/** True when the UI plan card pre-checks this item. */
export function isRecommendedItem(item: Pick<JunkItem, 'kind' | 'sizeBytes'>): boolean {
  return RECOMMENDED_PLAN.kinds.includes(item.kind) && item.sizeBytes >= RECOMMENDED_PLAN.minItemBytes
}

/**
 * Blocked POSIX system paths (defense in depth above root containment,
 * guarding against future registry misconfiguration). The list is the UNION
 * of the macOS and Linux red lines — blocking an extra system tree can only
 * refuse more, never allow more. `$HOME` and `~/Library` block equality only —
 * their descendants are where junk lives.
 */
const BLOCKED_PREFIXES_POSIX: readonly string[] = [
  '/System', '/usr', '/bin', '/sbin', '/etc', '/boot', '/srv',
  '/private/var/db', '/private/etc', '/Library',
  '/var/log', '/var/lib', '/var/db', '/var/cache',
  '/lib', '/lib64', '/lib32', '/libx32',
  '~/Library/Containers', '~/Library/Group Containers',
]

/**
 * Blocked Windows system trees. Built from the environment rather than
 * hard-coded to `C:` so a machine whose system drive is `D:` (or whose Program
 * Files live elsewhere) is still covered; the conventional locations stay as
 * fallbacks for a stripped-down environment. `$SystemDrive` itself and the
 * Recycle Bin under it are deliberately absent — the drive root is blocked
 * separately, and `$Recycle.Bin` is a registry root.
 */
export function windowsBlockedPrefixes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const systemDrive = (env.SystemDrive ?? 'C:').replace(/[\\/]+$/, '')
  const candidates = [
    env.SystemRoot, env.windir, `${systemDrive}\\Windows`,
    env.ProgramFiles, env.ProgramW6432, `${systemDrive}\\Program Files`,
    env['ProgramFiles(x86)'], `${systemDrive}\\Program Files (x86)`,
    env.ProgramData, `${systemDrive}\\ProgramData`,
    `${systemDrive}\\Recovery`, `${systemDrive}\\PerfLogs`, `${systemDrive}\\System Volume Information`,
    `${systemDrive}\\Users\\Default`, `${systemDrive}\\Users\\Public`, `${systemDrive}\\Users\\All Users`,
  ]
  const seen = new Set<string>()
  const prefixes: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const normalized = win32.normalize(candidate)
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    prefixes.push(normalized)
  }
  return prefixes
}

/** True when `path` is `prefix` or a descendant of it; case-folded on Windows. */
function isAtOrUnder(path: string, prefix: string, flavor: PathFlavor): boolean {
  const p = foldCase(flavor, apiFor(flavor).normalize(path))
  const b = foldCase(flavor, apiFor(flavor).normalize(prefix))
  if (p === b) return true
  const sep = flavor === 'win32' ? '\\' : '/'
  return p.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)
}

/** True when a candidate path must never be cleaned, regardless of registry contents. */
export function isBlockedPath(path: string, home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const flavor = pathFlavor(path)
  if (flavor === 'win32') return isBlockedWindowsPath(path, home, env)
  const p = posix.normalize(path)
  const h = posix.normalize(home)
  if (p === h || p === `${h}/Library` || p === '/Users' || p === '/home') return true
  for (const blocked of BLOCKED_PREFIXES_POSIX) {
    const b = posix.normalize(blocked.replace(/^~(?=\/)/, h))
    if (p === b || p.startsWith(`${b}/`)) return true
  }
  // Multi-user home roots, both layouts: every home tree except $HOME itself
  // (and its descendants) is off-limits — other users' data is never junk.
  for (const usersRoot of ['/Users', '/home']) {
    if (h.startsWith(`${usersRoot}/`)) {
      if (p.startsWith(`${usersRoot}/`) && !p.startsWith(`${h}/`)) return true
    } else if (p === usersRoot || p.startsWith(`${usersRoot}/`)) {
      return true
    }
  }
  // root's home is another user's home unless it IS $HOME.
  if (h !== '/root' && (p === '/root' || p.startsWith('/root/'))) return true
  return false
}

/**
 * The Windows half of {@link isBlockedPath}: the system trees, the drive roots
 * themselves, and every account tree other than `$HOME`. The multi-user rule
 * derives the account root from `$HOME`'s parent (rather than assuming
 * `C:\Users`) but only when that parent really is an account root, so a home
 * directory inside a deeper tree keeps its own descendants cleanable.
 */
function isBlockedWindowsPath(path: string, home: string, env: NodeJS.ProcessEnv): boolean {
  const p = win32.normalize(path)
  const h = win32.normalize(home)
  for (const blocked of windowsBlockedPrefixes(env)) {
    if (isAtOrUnder(p, blocked, 'win32')) return true
  }
  // A bare drive root (`C:\`) is never a reclaimable item.
  if (p.toLowerCase() === win32.parse(p).root.toLowerCase()) return true
  if (pathFlavor(home) !== 'win32') return false
  if (p.toLowerCase() === h.toLowerCase()) return true
  const accountRoot = win32.dirname(h)
  const isAccountRoot = win32.basename(accountRoot).toLowerCase() === 'users'
  if (!isAccountRoot) return false
  if (p.toLowerCase() === accountRoot.toLowerCase()) return true
  // Another account's tree, or the shared scaffolding under the account root.
  return isAtOrUnder(p, accountRoot, 'win32') && !isAtOrUnder(p, h, 'win32')
}

/**
 * Expand the placeholders a registry root may carry: a leading `~` becomes
 * `home` and `%NAME%` becomes the environment value (Windows roots are spelled
 * that way because the profile, the temp directory, and the system drive are
 * all relocatable). An unknown `%NAME%` is left verbatim — the root then
 * simply does not exist, which yields no items rather than a wrong path.
 * Exported for tests and future filters.
 */
export function resolveTargets(
  targets: readonly JunkTarget[] = JUNK_TARGETS,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): readonly JunkTarget[] {
  return targets.map(target => ({ ...target, dir: expandRoot(target.dir, home, env) }))
}

/** One registry root through `~`/`%NAME%` expansion. */
function expandRoot(dir: string, home: string, env: NodeJS.ProcessEnv): string {
  const withHome = dir.replace(/^~(?=[\\/])/, home)
  return withHome.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
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
  const flavor = pathFlavor(target.dir)
  const api = apiFor(flavor)
  const sep = flavor === 'win32' ? '\\' : '/'
  const root = api.parse(target.dir).root
  let currents: string[] = [root]
  for (const segment of target.dir.slice(root.length).split(sep).filter(part => part.length > 0)) {
    const next: string[] = []
    if (segment !== '*') {
      for (const current of currents) next.push(api.join(current, segment))
    } else {
      for (const current of currents) {
        try {
          const entries: Dirent[] = await readdir(current, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) next.push(api.join(current, entry.name))
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
    const entryPath = joinPath(dir, entry.name)
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

/** Platforms the junk domain supports; everything else is refused whole. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'linux', 'win32'])

function assertSupportedPlatform(plat: NodeJS.Platform = platform()): void {
  if (!SUPPORTED_PLATFORMS.has(plat)) {
    throw new PcManagerError('unsupported_platform', 'junk scan/clean support macOS, Linux, and Windows hosts.')
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
  /** Overrides the platform gate (default os.platform()); a test seam. */
  platform?: NodeJS.Platform
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
  assertSupportedPlatform(options.platform ?? platform())
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
    const childPath = joinPath(target.dir, entry.name)
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
 * the vocabulary or the path is not absolute in its own flavor. The split is
 * at the FIRST colon, which is what lets a Windows path keep its drive colon
 * (`trash:C:\$Recycle.Bin`) — no kind name contains a colon.
 */
export function parseJunkId(id: string): { kind: JunkKind, path: string } | null {
  const separator = id.indexOf(':')
  if (separator <= 0) return null
  const kind = id.slice(0, separator) as JunkKind
  const path = id.slice(separator + 1)
  if (!(JUNK_KINDS as readonly string[]).includes(kind)) return null
  if (!isAbsolutePath(path)) return null
  return { kind, path }
}

/** Strict descendant check after normalization in the root's own flavor;
 * equality is not "under". */
function isStrictlyUnder(path: string, root: string): boolean {
  const flavor = pathFlavor(root)
  const api = apiFor(flavor)
  const p = foldCase(flavor, normalizeLiteral(api, path))
  const r = foldCase(flavor, normalizeLiteral(api, root))
  if (p === r) return false
  const sep = flavor === 'win32' ? '\\' : '/'
  return p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`)
}

/** Equality after normalization in the second literal's flavor, case-folded on
 * Windows (`C:\Users\T` and `c:\users\t` are the same directory there). */
function samePath(a: string, b: string): boolean {
  const flavor = pathFlavor(b)
  const api = apiFor(flavor)
  return foldCase(flavor, normalizeLiteral(api, a)) === foldCase(flavor, normalizeLiteral(api, b))
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
      target.granularity === 'whole' ? samePath(path, target.dir) : isStrictlyUnder(path, target.dir))
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
      realPath = await realpath(normalizePath(path))
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
        const within = target.granularity === 'whole' ? samePath(realPath, realRoot) : isStrictlyUnder(realPath, realRoot)
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

/** Absolute path of the macOS system trash utility (15+); called without PATH lookup. */
export const TRASH_BIN = '/usr/bin/trash'

/** Linux trash-put candidates (trash-cli), most preferred first. */
export const LINUX_TRASH_BINS: readonly string[] = ['/usr/bin/trash-put', '/usr/local/bin/trash-put']

/** GLib's trash helper (`gio trash <paths>`), the Linux tier-1 fallback. */
const GIO_TRASH = { bin: '/usr/bin/gio', args: ['trash'] } as const

/** Timeout for one tier-1 trash invocation. */
const TRASH_TIMEOUT_MS = 30_000

/**
 * The Windows tier-1 recycle script for one concrete path list.
 *
 * The paths are embedded as PowerShell literals rather than appended as argv:
 * `-Command` re-joins its arguments with spaces, so a path containing a space
 * silently splits into two arguments (and a multi-statement script receives
 * nothing at all in `$args`). Single quotes are the only character PowerShell
 * needs escaped, doubled inside a single-quoted literal. The .NET
 * `Microsoft.VisualBasic` recycle API is the same `SendToRecycleBin` the
 * Explorer shell performs, so recoverable items land in the real Recycle Bin
 * with their original location. Spelled with `-Command` (never a .ps1 file),
 * so a Restricted execution policy cannot block it.
 */
export function windowsRecycleScript(paths: readonly string[]): string {
  const literals = paths.map(path => `'${path.replace(/'/g, "''")}'`).join(', ')
  return [
    PS_PREAMBLE,
    "$ErrorActionPreference = 'Stop'",
    `$targets = @(${literals})`,
    // A silent no-op would be reported as reclaimed bytes; fail loudly instead
    // so the caller falls through to the rename tier.
    "if ($targets.Count -eq 0) { throw 'pc-manager: no recycle targets were passed' }",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    'foreach ($target in $targets) {',
    '  if ([System.IO.Directory]::Exists($target)) {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '  } else {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '  }',
    '}',
  ].join('\n')
}

/** One resolved tier-1 trash command. */
export interface TrashCommand {
  bin: string
  /**
   * Full argv for one path list. Built per call because the Windows tier
   * embeds the paths in its script text (see {@link windowsRecycleScript});
   * the POSIX tiers simply append them.
   */
  buildArgs(paths: readonly string[]): readonly string[]
}

/** Injectable indirections so tests can exercise every trash tier offline. */
export interface CleanIo {
  /** Tier 1: hand paths to the platform's trash utility. */
  runTrashCommand(paths: readonly string[]): Promise<void>
  /** Tier 2 primitive; tests inject an EXDEV-throwing rename to reach tier 3. */
  rename(from: string, to: string): Promise<void>
}

/** Options for {@link cleanJunk}; `home`, `platform` and `io` are test seams. */
export interface CleanJunkOptions {
  signal?: AbortSignal
  /** Overrides the home directory backing the trash layout (default os.homedir()). */
  home?: string
  /** Overrides the platform selecting the trash layout and tier-1 utility (default os.platform()). */
  platform?: NodeJS.Platform
  /** Partial override of the fs/exec indirections. */
  io?: Partial<CleanIo>
}

const runFile = promisify(execFile)

const defaultIo: CleanIo = {
  runTrashCommand: async paths => {
    const command = await resolveTrashCommand()
    if (command === null) throw new Error('no trash utility available on this platform')
    await runFile(command.bin, [...command.buildArgs(paths)], { timeout: TRASH_TIMEOUT_MS })
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

/** argv-appending tier-1 command (macOS `trash`, Linux `trash-put`/`gio trash`). */
function argvTrashCommand(bin: string, prefix: readonly string[] = []): TrashCommand {
  return { bin, buildArgs: paths => [...prefix, ...paths] }
}

/** Resolve the platform's tier-1 trash utility by existence probe; null when absent. */
export async function resolveTrashCommand(plat: NodeJS.Platform = platform()): Promise<TrashCommand | null> {
  if (plat === 'darwin') {
    return await canExecute(TRASH_BIN) ? argvTrashCommand(TRASH_BIN) : null
  }
  if (plat === 'linux') {
    for (const bin of LINUX_TRASH_BINS) {
      if (await canExecute(bin)) return argvTrashCommand(bin)
    }
    return await canExecute(GIO_TRASH.bin) ? argvTrashCommand(GIO_TRASH.bin, GIO_TRASH.args) : null
  }
  if (plat === 'win32') {
    const bin = await resolvePowershell()
    if (bin === null) return null
    return { bin, buildArgs: paths => [...PS_ARGV, windowsRecycleScript(paths)] }
  }
  return null
}

/** The trash directory faces of one platform: macOS keeps a flat `~/.Trash`;
 * Linux follows the freedesktop spec with `files/` and `info/` subdirs;
 * Windows' real Recycle Bin is a per-volume `$Recycle.Bin` owned by the shell,
 * so its tier-2 fallback is a private holding directory inside the profile
 * (reached only when the shell recycle API is unavailable — the outcome is
 * still recoverable, just not from the Windows Recycle Bin UI). */
export interface TrashDirs {
  root: string
  /** Where trashed items live (equals `root` on macOS and Windows). */
  files: string
  /** Restore-record directory; null where the platform keeps no such metadata. */
  info: string | null
}

/** The trash layout for `home` under `plat`; exported for tests. Joins are
 * flavor-aware, so a POSIX `home` yields a POSIX layout on any host (and a
 * Windows `home` yields the profile-relative one). */
export function trashDirs(plat: NodeJS.Platform, home: string): TrashDirs {
  if (plat === 'linux') {
    const root = joinPath(home, '.local/share/Trash')
    return { root, files: joinPath(root, 'files'), info: joinPath(root, 'info') }
  }
  if (plat === 'win32') {
    const root = joinPath(home, 'AppData/Local/pc-manager/trash')
    return { root, files: root, info: null }
  }
  const root = joinPath(home, '.Trash')
  return { root, files: root, info: null }
}

/**
 * Reject a trash-directory face that is not a directory, not ours, or
 * writable by group/others — a world-writable trash destination would let
 * anything intercept "recovered" files. Missing faces are created 0700.
 *
 * Ownership and mode bits are POSIX concepts: Windows reports synthesized
 * modes that say nothing about the ACL, and `process.getuid()` does not exist
 * there. The Windows faces are therefore only vetted structurally — they sit
 * inside the account's own profile — and rely on the profile ACL Windows
 * already enforces.
 */
async function ensureSafeTrashDirs(dirs: TrashDirs): Promise<void> {
  const uid = process.getuid?.()
  for (const dir of [dirs.root, dirs.files, dirs.info]) {
    if (dir === null) continue
    let stat: Stats
    try {
      stat = await lstat(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(dir, { recursive: true, mode: 0o700 })
      continue
    }
    if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`)
    if (uid === undefined) continue
    if (stat.uid !== uid) throw new Error(`${dir} is not owned by the current user`)
    if ((stat.mode & 0o022) !== 0) throw new Error(`${dir} is group- or other-writable`)
  }
}

/** First free `name`, `name 2`, `name 3`, … — free in BOTH the files face and
 * the info face, so a leftover `.trashinfo` never orphans a fresh entry. */
async function reserveTrashName(dirs: TrashDirs, name: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} ${attempt}`
    const taken = await Promise.all([
      lstat(joinPath(dirs.files, candidate)).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }),
      dirs.info === null
        ? Promise.resolve(false)
        : lstat(joinPath(dirs.info, `${candidate}.trashinfo`)).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
          }),
    ])
    if (!taken.some(Boolean)) return candidate
  }
}

/**
 * The freedesktop restore record for one trashed item (`info/<name>.trashinfo`).
 * Without it desktop trash UIs still list the item but cannot offer Put Back —
 * writing it makes tier-2 recovery path-aware.
 */
async function writeTrashInfo(infoDir: string, name: string, originalPath: string): Promise<void> {
  const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const content = `[Trash Info]\nPath=${encodeURI(originalPath)}\nDeletionDate=${deletionDate}\n`
  await writeFile(joinPath(infoDir, `${name}.trashinfo`), content, { mode: 0o600 })
}

/** True when the path still exists (symlink-aware; any error reads as gone). */
async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

/**
 * Move one item to the trash: tier 1 hands it to the platform's shell-aware
 * utility, tier 2 renames it into the platform's trash layout (adding the
 * freedesktop restore record where one exists), tier 3 copies across volumes
 * and removes the source.
 */
async function moveToTrash(path: string, home: string, io: CleanIo, tier1Usable: boolean, plat: NodeJS.Platform): Promise<void> {
  if (tier1Usable) {
    try {
      await io.runTrashCommand([path])
      // The utility claimed success; confirm the source actually left before
      // reporting reclaimed bytes. A silent no-op (a policy-blocked shell API,
      // a helper that ignored its argument list) must fall through to the
      // rename tier instead of reporting phantom bytes.
      if (!await pathExists(path)) return
      throw new Error('the trash utility reported success but the source is still there')
    } catch (error) {
      console.warn(`[pc-manager] trash utility failed, falling back to rename: ${String(error)}`)
    }
  }
  const dirs = trashDirs(plat, home)
  await ensureSafeTrashDirs(dirs)
  const name = await reserveTrashName(dirs, basenamePath(path))
  const dest = joinPath(dirs.files, name)
  try {
    await io.rename(path, dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // Cross-volume last resort: copy in, verify the copy landed, then remove
    // the source. A failure before the rm leaves the source untouched.
    await cp(path, dest, { recursive: true, force: false })
    await lstat(dest)
    await rm(path, { recursive: true, force: false })
  }
  // The restore record is best-effort metadata: a failure here must not undo
  // a completed move, only cost the Put Back affordance.
  if (dirs.info !== null) {
    await writeTrashInfo(dirs.info, name, path).catch(error => {
      console.warn(`[pc-manager] trashinfo write failed for ${path}: ${String(error)}`)
    })
  }
}

/** Remove every child of `dir`, keeping the directory itself. */
async function emptyDirectory(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    await rm(joinPath(dir, entry), { recursive: true, force: false })
  }
}

/** Empty the trash kind in place (moving entries of the trash back into the
 * trash would be a no-op): macOS clears the flat root, Linux clears the
 * contents of `files/` and `info/` while keeping the layout directories, and
 * Windows clears the account's `$Recycle.Bin` folder — which IS the local
 * "empty the Recycle Bin" operation for that volume. */
async function emptyTrash(dirs: TrashDirs): Promise<void> {
  await emptyDirectory(dirs.files)
  if (dirs.info !== null) await emptyDirectory(dirs.info)
}

/**
 * Reclaim the selected junk items. All ids pass the structural validation
 * chain first — one invalid id rejects the whole batch with zero deletions.
 * Per item: vanished targets report `not_found`; re-measure failure skips the
 * item untouched; trash mode tiers through the platform's trash utility
 * (macOS /usr/bin/trash; Linux trash-put/gio trash), rename into the trash
 * layout (~/.Trash or ~/.local/share/Trash with a .trashinfo restore record),
 * and cross-volume copy+remove. The `trash` kind empties the layout in place
 * (moving entries of the trash back into the trash would be a no-op).
 * Failures surface per-item, never silently.
 */
export async function cleanJunk(
  ids: readonly string[],
  mode: 'trash' | 'delete',
  targets: readonly JunkTarget[] = resolveTargets(),
  options: CleanJunkOptions = {},
): Promise<JunkCleanResult> {
  const plat = options.platform ?? platform()
  assertSupportedPlatform(plat)
  if (ids.length === 0) {
    throw new PcManagerError('invalid_argument', 'cleanJunk requires at least one junk item id.')
  }
  const home = options.home ?? homedir()
  const io: CleanIo = { ...defaultIo, ...options.io }
  const expanded = await expandGlobs(targets)
  await validateJunkIds(ids, expanded, home)

  const tier1Usable = mode === 'trash'
    && (options.io?.runTrashCommand !== undefined || (await resolveTrashCommand(plat)) !== null)
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
        // Emptying the trash is the destructive act itself; its contents have
        // no further trash to go to. The item path IS the registry's trash
        // root (whole granularity on macOS/Linux, the account's own
        // `$Recycle.Bin` folder on Windows), so the layout derives from it.
        await emptyTrash(plat === 'linux'
          ? { root: path, files: joinPath(path, 'files'), info: joinPath(path, 'info') }
          : { root: path, files: path, info: null })
      } else if (mode === 'delete') {
        await rm(path, { recursive: true, force: false })
      } else {
        await moveToTrash(path, home, io, tier1Usable, plat)
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
