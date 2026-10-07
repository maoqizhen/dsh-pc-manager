/**
 * Junk-domain tests: registry and protection pins, the size walk, scan
 * semantics, the id validation chain, every trash tier, and the approval
 * summary. All fixtures live in tmpdirs with injected targets and io seams —
 * no real home directory or system Trash is ever touched. Runs under the
 * harness vitest:
 *   cd deepseek-harness && node_modules/.bin/vitest run --root ../dsh-pc-manager-plugin/pc-manager
 * @module @deepseek-ai/dsh-pc-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  EDR_PROTECTED_PREFIXES, JUNK_KINDS, JUNK_TARGETS, JUNK_TARGETS_DARWIN, JUNK_TARGETS_LINUX, JUNK_TARGETS_WIN32,
  LINUX_PROTECTED_CHILDREN, LINUX_TEMP_PROTECTED, PROTECTED_CHILDREN, WINDOWS_SYSTEM_SIDS, WINDOWS_TEMP_PROTECTED,
  cleanJunk, computeRecommendedPlan, describeJunkIds, expandGlobs,
  isBlockedPath, isRecommendedItem, matchesProtectedRule, measureTree, parseJunkId, resolveTargets, resolveTrashCommand,
  scanJunk, trashDirs, validateJunkIds,
} from '../src/junk.ts'
import type { JunkTarget } from '../src/junk.ts'

let base = ''
let homeSeq = 0

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'pc-junk-'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** A test target with defaults mirroring the registry's children-granularity rows. */
function target(kind: string, dir: string, extra: Partial<JunkTarget> = {}): JunkTarget {
  return {
    kind: kind as JunkTarget['kind'],
    label: `${kind} 测试`,
    dir,
    safeToClean: true,
    rationale: `${kind} test rationale`,
    granularity: 'children',
    ...extra,
  }
}

/** Write a file of exactly `bytes` bytes, creating parent directories. */
async function put(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 1))
}

/**
 * Create a directory link to `target`. POSIX uses a symlink; Windows uses a
 * directory junction, which is the unprivileged equivalent — a real symlink
 * needs Developer Mode or an elevated token. Node reports both as symlinks
 * (`lstat().isSymbolicLink()`), so the walk's no-follow rule and the realpath
 * defense are exercised identically on all three platforms.
 */
async function linkDir(target: string, path: string): Promise<void> {
  await (platform() === 'win32' ? symlink(target, path, 'junction') : symlink(target, path))
}

/** A fresh fake home with a sane trash layout for the platform (0700, owned by the runner). */
async function freshHome(plat: NodeJS.Platform = 'darwin'): Promise<string> {
  homeSeq += 1
  const home = join(base, `home-${homeSeq}`)
  const dirs = trashDirs(plat, home)
  await mkdir(dirs.files, { recursive: true, mode: 0o700 })
  if (dirs.info !== null) await mkdir(dirs.info, { recursive: true, mode: 0o700 })
  return home
}

/** io seam that forces the rename tier by making tier 1 fail. */
const noTrashBin = {
  runTrashCommand: async (_paths: readonly string[]) => {
    throw new Error('trash utility unavailable in tests')
  },
}

/**
 * Permission-degradation tests need POSIX permission semantics: root's
 * CAP_DAC_OVERRIDE reads straight through 0000 modes, and Windows `chmod`
 * only toggles the read-only attribute (it cannot deny read through the ACL),
 * so the EACCES premise holds on neither (design doc §11 anticipated
 * "root 下 skip").
 */
const itNeedsPosixPermissions = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

describe('registry and protection lists', () => {
  it('registers the macOS registry as 19 rows over 18 kinds with the intended safety split', () => {
    expect(JUNK_TARGETS_DARWIN).toHaveLength(19)
    expect(new Set(JUNK_TARGETS_DARWIN.map(row => row.kind)).size).toBe(18)
    expect(JUNK_KINDS).toHaveLength(18)
    const unsafe = [...new Set(JUNK_TARGETS_DARWIN.filter(row => !row.safeToClean).map(row => row.kind))].sort()
    expect(unsafe).toEqual(['pnpm-store', 'simulator-unavailable-devices'])
  })

  it('registers the Linux registry as 12 rows over 11 kinds on the XDG layout', () => {
    expect(JUNK_TARGETS_LINUX).toHaveLength(12)
    expect(new Set(JUNK_TARGETS_LINUX.map(row => row.kind)).size).toBe(11)
    expect(JUNK_TARGETS_LINUX.filter(row => row.kind === 'system-temp').map(row => row.dir)).toEqual(['/tmp', '/var/tmp'])
    expect(JUNK_TARGETS_LINUX.filter(row => row.kind === 'trash')[0]?.dir).toBe('~/.local/share/Trash')
    expect(JUNK_TARGETS_LINUX.filter(row => row.kind === 'user-caches')[0]?.dir).toBe('~/.cache')
    const unsafe = [...new Set(JUNK_TARGETS_LINUX.filter(row => !row.safeToClean).map(row => row.kind))]
    expect(unsafe).toEqual(['pnpm-store'])
    // macOS-only kinds never appear as Linux rows.
    for (const macOnly of ['user-logs', 'xcode-derived-data', 'xcode-archives', 'xcode-ios-device-support',
      'xcode-simulator-caches', 'simulator-unavailable-devices', 'ios-backups']) {
      expect(JUNK_TARGETS_LINUX.some(row => row.kind === macOnly)).toBe(false)
    }
  })

  it('registers the Windows registry as 18 rows over 11 kinds on %VAR% roots', () => {
    expect(JUNK_TARGETS_WIN32).toHaveLength(18)
    expect(new Set(JUNK_TARGETS_WIN32.map(row => row.kind)).size).toBe(11)
    expect(JUNK_TARGETS_WIN32.filter(row => row.kind === 'system-temp').map(row => row.dir))
      .toEqual(['%TEMP%', '%SystemRoot%\\Temp'])
    expect(JUNK_TARGETS_WIN32.filter(row => row.kind === 'trash')[0]?.dir).toBe('%SystemDrive%\\$Recycle.Bin')
    expect(JUNK_TARGETS_WIN32.filter(row => row.kind === 'trash')[0]?.granularity).toBe('children')
    expect(JUNK_TARGETS_WIN32.filter(row => row.kind === 'trash')[0]?.protectedChildren).toBe(WINDOWS_SYSTEM_SIDS)
    const unsafe = [...new Set(JUNK_TARGETS_WIN32.filter(row => !row.safeToClean).map(row => row.kind))]
    expect(unsafe).toEqual(['pnpm-store'])
    // macOS-only and Homebrew kinds never appear as Windows rows (user-logs
    // does: WER archives and crash dumps are the Windows analogue).
    for (const absent of ['xcode-derived-data', 'xcode-archives', 'xcode-ios-device-support',
      'xcode-simulator-caches', 'simulator-unavailable-devices', 'ios-backups', 'homebrew-cache']) {
      expect(JUNK_TARGETS_WIN32.some(row => row.kind === absent)).toBe(false)
    }
    expect(JUNK_TARGETS_WIN32.filter(row => row.kind === 'user-logs')).toHaveLength(3)
    // Every Windows root is either %VAR%-anchored or profile-anchored — never
    // a bare drive-relative literal.
    for (const row of JUNK_TARGETS_WIN32) {
      expect(row.dir.startsWith('%') || row.dir.startsWith('~')).toBe(true)
    }
    const tempRows = JUNK_TARGETS_WIN32.filter(row => row.kind === 'system-temp')
    expect(tempRows.every(row => row.protectedChildren === WINDOWS_TEMP_PROTECTED && row.minAgeDays === 3)).toBe(true)
  })

  it('pins the Windows temp protection list (live installers and EDR)', () => {
    expect(WINDOWS_TEMP_PROTECTED).toEqual([
      'CrowdStrike', 'CSFalcon', 'SentinelOne', 'Sentinel', 'Sophos', 'Tanium', 'CarbonBlack', 'CbDefense',
      'mde', 'MsMpEng', 'MpCmdRun', 'MpEngine', 'Defender', 'avast', 'AVG', 'ESET', 'Kaspersky',
      'scoped_dir', 'chrome_installer', 'VSIXInstaller', 'Microsoft Visual Studio', 'Roslyn',
    ])
    expect(WINDOWS_SYSTEM_SIDS).toEqual(['S-1-5-18', 'S-1-5-19', 'S-1-5-20'])
  })

  it('dispatches JUNK_TARGETS by the runtime platform', () => {
    const expected = platform() === 'linux' ? JUNK_TARGETS_LINUX
      : platform() === 'win32' ? JUNK_TARGETS_WIN32
        : JUNK_TARGETS_DARWIN
    expect(JUNK_TARGETS).toBe(expected)
  })

  it('pins every sensitive-cache protection rule (macOS)', () => {
    expect(PROTECTED_CHILDREN).toEqual([
      'com.1password.', 'com.agilebits.', 'com.bitwarden.', 'com.keepassx.', 'org.keepassxc.', 'com.lastpass.', 'com.dashlane.',
      'com.jetbrains.', 'com.microsoft.VSCode', 'com.visualstudio.code.', 'com.sublimetext.',
      'im.rime.', 'com.sogou.inputmethod.', 'com.baidu.inputmethod.', '*.inputmethod',
      'com.wireguard.', 'io.tailscale.', 'com.zerotier.', 'net.openvpn.', '*clash*', '*Clash*',
      'com.dropbox.', 'com.getdropbox.', 'com.google.GoogleDrive', 'com.microsoft.OneDrive',
      'com.anthropic.claude', 'com.openai.chat', 'com.ollama.', 'page.jan.jan',
    ])
  })

  it('pins every Linux ~/.cache protection rule', () => {
    expect(LINUX_PROTECTED_CHILDREN).toEqual([
      '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane',
      'jetbrains', 'vscode', 'Code', 'sublime-text', 'sublime',
      'fcitx', 'ibus', 'rime',
      'clash', 'Clash', 'tailscale', 'Tailscale', 'openvpn', 'OpenVPN',
      'wireguard', 'WireGuard', 'zerotier', 'mullvad',
      'dropbox', 'Dropbox', 'onedrive', 'OneDrive', 'google-drive', 'nextcloud', 'syncthing',
      'ollama', 'jan', 'lm-studio', 'claude', 'Claude',
    ])
  })

  it('pins the Linux temp protection list (live services and EDR)', () => {
    expect(LINUX_TEMP_PROTECTED).toEqual([
      'systemd-private-', 'snap-private-tmp',
      'falcon', 'crowdstrike', 'sentinelone', 's1agent', 'carbonblack', 'cb-defense',
      'mde', 'sophos', 'defender',
    ])
  })

  it('pins every EDR prefix and attaches protections to the right rows', () => {
    expect(EDR_PROTECTED_PREFIXES).toEqual([
      'com.crowdstrike.', 'com.sentinelone.', 'com.sentinel-labs.', 'com.eset.',
      'com.jamf.', 'com.jamfsoftware.', 'com.paloaltonetworks.', 'com.cisco.anyconnect', 'com.cisco.secureclient',
    ])
    expect(JUNK_TARGETS_DARWIN.filter(row => row.kind === 'user-caches').every(row => row.protectedChildren === PROTECTED_CHILDREN)).toBe(true)
    const systemTemp = JUNK_TARGETS_DARWIN.filter(row => row.kind === 'system-temp')
    expect(systemTemp).toHaveLength(2)
    expect(systemTemp.every(row => row.protectedChildren === EDR_PROTECTED_PREFIXES && row.minAgeDays === 3)).toBe(true)
    expect(JUNK_TARGETS_LINUX.filter(row => row.kind === 'user-caches').every(row => row.protectedChildren === LINUX_PROTECTED_CHILDREN)).toBe(true)
    const linuxTemp = JUNK_TARGETS_LINUX.filter(row => row.kind === 'system-temp')
    expect(linuxTemp).toHaveLength(2)
    expect(linuxTemp.every(row => row.protectedChildren === LINUX_TEMP_PROTECTED && row.minAgeDays === 3)).toBe(true)
  })

  it('matches prefix, suffix, and substring rules', () => {
    expect(matchesProtectedRule('com.jetbrains.intellij', 'com.jetbrains.')).toBe(true)
    expect(matchesProtectedRule('org.example.app', 'com.jetbrains.')).toBe(false)
    expect(matchesProtectedRule('com.apple.inputmethod', '*.inputmethod')).toBe(true)
    expect(matchesProtectedRule('com.apple.inputmethod.extra', '*.inputmethod')).toBe(false)
    expect(matchesProtectedRule('net.pietje.clashx', '*clash*')).toBe(true)
    expect(matchesProtectedRule('ClashX Pro', '*Clash*')).toBe(true)
    expect(matchesProtectedRule('systemd-private-sshd.service-x/tmp', 'systemd-private-')).toBe(true)
  })
})

describe('recommended plan preset', () => {
  it('pre-checks every safe regenerable kind on the macOS registry', () => {
    expect([...computeRecommendedPlan(JUNK_TARGETS_DARWIN).kinds].sort()).toEqual([
      'go-build-cache', 'go-mod-cache', 'homebrew-cache', 'npm-cache', 'pip-cache', 'system-temp',
      'trash', 'user-caches', 'user-logs', 'uv-cache', 'xcode-derived-data',
      'xcode-ios-device-support', 'xcode-simulator-caches', 'yarn-cache',
    ])
    // Non-regenerable and not-directly-cleanable kinds are never pre-checked.
    const darwin = computeRecommendedPlan(JUNK_TARGETS_DARWIN).kinds
    expect(darwin).not.toContain('ios-backups')
    expect(darwin).not.toContain('xcode-archives')
    expect(darwin).not.toContain('pnpm-store')
    expect(darwin).not.toContain('simulator-unavailable-devices')
  })

  it('pre-checks the safe kinds on the Linux registry (no non-regenerable rows there)', () => {
    expect([...computeRecommendedPlan(JUNK_TARGETS_LINUX).kinds].sort()).toEqual([
      'go-build-cache', 'go-mod-cache', 'homebrew-cache', 'npm-cache', 'pip-cache', 'system-temp',
      'trash', 'user-caches', 'uv-cache', 'yarn-cache',
    ])
  })

  it('requires the 1 MiB threshold for a pre-checked item', () => {
    for (const plan of [computeRecommendedPlan(JUNK_TARGETS_DARWIN), computeRecommendedPlan(JUNK_TARGETS_LINUX)]) {
      expect(plan.minItemBytes).toBe(1024 * 1024)
    }
    expect(isRecommendedItem({ kind: 'user-caches', sizeBytes: 1024 * 1024 })).toBe(true)
    expect(isRecommendedItem({ kind: 'user-caches', sizeBytes: 1024 * 1024 - 1 })).toBe(false)
    expect(isRecommendedItem({ kind: 'ios-backups', sizeBytes: 1024 ** 3 })).toBe(false)
    expect(isRecommendedItem({ kind: 'pnpm-store', sizeBytes: 1024 ** 3 })).toBe(false)
  })
})

describe('resolveTargets and expandGlobs', () => {
  it('expands ~ against the given home', () => {
    const [row] = resolveTargets([target('trash', '~/.Trash')], '/Users/tester')
    expect(row?.dir).toBe('/Users/tester/.Trash')
  })

  it('expands whole-segment globs over directories only', async () => {
    await mkdir(join(base, 'folders/a/x/C'), { recursive: true })
    await mkdir(join(base, 'folders/b/y/C'), { recursive: true })
    await put(join(base, 'folders/c.txt'), 4)
    const expanded = await expandGlobs([target('system-temp', join(base, 'folders/*/*/C'))])
    expect(expanded.map(row => row.dir).sort()).toEqual([
      join(base, 'folders/a/x/C'),
      join(base, 'folders/b/y/C'),
    ])
  })

  it('yields nothing when no branch exists', async () => {
    const expanded = await expandGlobs([target('system-temp', join(base, 'missing/*/*/C'))])
    expect(expanded).toEqual([])
  })
})

describe('parseJunkId', () => {
  it('splits at the first colon and validates the vocabulary', () => {
    expect(parseJunkId('user-caches:/Users/x/Library/Caches/com.google.Chrome'))
      .toEqual({ kind: 'user-caches', path: '/Users/x/Library/Caches/com.google.Chrome' })
    expect(parseJunkId('noSeparator')).toBeNull()
    expect(parseJunkId(':etc')).toBeNull()
    expect(parseJunkId('made-up-kind:/etc')).toBeNull()
    expect(parseJunkId('user-caches:relative/path')).toBeNull()
  })
})

describe('measureTree', () => {
  it('sums nested sizes and file counts without following symlinks', async () => {
    const root = join(base, 'walk-nested')
    await put(join(root, 'a.bin'), 100)
    await put(join(root, 'sub/b.bin'), 50)
    await put(join(root, 'sub/deep/c.bin'), 25)
    await put(join(base, 'walk-outside-target'), 10_000)
    await linkDir(join(base, 'walk-outside-target'), join(root, 'sub/link'))
    const { sizeBytes: linkSize } = await measureTree(join(root, 'sub/link'))
    const measure = await measureTree(root)
    expect(measure.sizeBytes).toBe(100 + 50 + 25 + linkSize)
    expect(measure.fileCount).toBe(4)
    expect(measure.degraded).toEqual([])
  })

  it('tracks the subtree max mtime', async () => {
    const root = join(base, 'walk-mtime')
    const old = new Date('2020-01-01T00:00:00.000Z')
    await put(join(root, 'old.bin'), 1)
    await utimes(join(root, 'old.bin'), old, old)
    const fresh = await measureTree(root)
    expect(fresh.maxMtimeMs).not.toBeNull()
    expect(fresh.maxMtimeMs as number).toBeGreaterThan(old.getTime())
    await utimes(root, old, old)
    const stale = await measureTree(root)
    expect(stale.maxMtimeMs).toBe(old.getTime())
  })

  itNeedsPosixPermissions('records permission-degraded subtrees instead of failing the walk', async () => {
    const root = join(base, 'walk-eacces')
    await put(join(root, 'top.bin'), 10)
    await put(join(root, 'locked/inner.bin'), 999)
    await chmod(join(root, 'locked'), 0o000)
    try {
      const measure = await measureTree(root)
      expect(measure.sizeBytes).toBe(10)
      expect(measure.degraded).toEqual([{ path: join(root, 'locked'), code: 'EACCES' }])
    } finally {
      await chmod(join(root, 'locked'), 0o700)
    }
  })

  it('propagates ENOENT for a missing root', async () => {
    await expect(measureTree(join(base, 'walk-missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('scanJunk', () => {
  it('lists first-level children with labels, sizes, and lastModifiedAt', async () => {
    const caches = join(base, 'scan-children')
    await put(join(caches, 'com.google.Chrome/blob'), 4096)
    const report = await scanJunk({}, [target('user-caches', caches)])
    expect(report.items).toHaveLength(1)
    const item = report.items[0] as typeof report.items[number]
    expect(item.id).toBe(`user-caches:${join(caches, 'com.google.Chrome')}`)
    expect(item.label).toBe('com.google.Chrome')
    expect(item.sizeBytes).toBe(4096)
    expect(item.fileCount).toBe(1)
    expect(item.safeToClean).toBe(true)
    expect(item.lastModifiedAt).not.toBeNull()
    expect(Number.isNaN(Date.parse(item.lastModifiedAt as string))).toBe(false)
    expect(report.totalBytes).toBe(4096)
  })

  it('emits one whole-root item whose id is the root itself and whose mtime is the root mtime', async () => {
    const root = join(base, 'scan-whole')
    const old = new Date('2020-06-01T00:00:00.000Z')
    await put(join(root, 'f1'), 100)
    await utimes(root, old, old)
    const report = await scanJunk({}, [target('npm-cache', root, { granularity: 'whole' })])
    expect(report.items.map(item => item.id)).toEqual([`npm-cache:${root}`])
    expect(report.items[0]?.label).toBe('npm-cache 测试')
    expect(report.items[0]?.lastModifiedAt).toBe(old.toISOString())
  })

  it('hides protected children in skipped and excludes overlap roots from the parent kind', async () => {
    const caches = join(base, 'scan-protected')
    await put(join(caches, 'com.jetbrains.idea/index'), 5)
    await put(join(caches, 'Homebrew/downloads'), 7)
    await put(join(caches, 'com.google.Chrome/blob'), 3)
    const targets = [
      target('user-caches', caches, { protectedChildren: ['com.jetbrains.'] }),
      target('homebrew-cache', join(caches, 'Homebrew')),
    ]
    const report = await scanJunk({}, targets)
    expect(report.items.map(item => item.kind).sort()).toEqual(['homebrew-cache', 'user-caches'])
    expect(report.items.map(item => item.path)).not.toContain(join(caches, 'Homebrew'))
    expect(report.skipped).toContainEqual({ path: join(caches, 'com.jetbrains.idea'), reason: 'protected child (rule: com.jetbrains.)' })
  })

  it('applies minAgeDays from the subtree max mtime', async () => {
    const root = join(base, 'scan-minage')
    const old = new Date(Date.now() - 10 * 86_400_000)
    await put(join(root, 'old-dir/f'), 1)
    await put(join(root, 'fresh-dir/f'), 1)
    await utimes(join(root, 'old-dir/f'), old, old)
    await utimes(join(root, 'old-dir'), old, old)
    const report = await scanJunk({}, [target('system-temp', root, { minAgeDays: 3 })])
    expect(report.items.map(item => item.label)).toEqual(['old-dir'])
  })

  it('applies minItemBytes, sorts descending, and keeps totalBytes equal to the listed sum', async () => {
    const root = join(base, 'scan-minbytes')
    await put(join(root, 'small'), 10)
    await put(join(root, 'middle'), 200)
    await put(join(root, 'large'), 3000)
    const report = await scanJunk({ minItemBytes: 100 }, [target('user-caches', root)])
    expect(report.items.map(item => item.label)).toEqual(['large', 'middle'])
    expect(report.totalBytes).toBe(3200)
    expect(report.totalBytes).toBe(report.items.reduce((sum, item) => sum + item.sizeBytes, 0))
  })

  it('filters targets by kinds', async () => {
    const one = join(base, 'scan-kinds-a')
    const two = join(base, 'scan-kinds-b')
    await put(join(one, 'child'), 1)
    await put(join(two, 'child'), 1)
    const report = await scanJunk({ kinds: ['user-logs'] }, [
      target('user-caches', one),
      target('user-logs', two),
    ])
    expect(report.items.map(item => item.kind)).toEqual(['user-logs'])
  })

  it('missing roots yield no items, and all-missing scans return empty', async () => {
    const report = await scanJunk({}, [
      target('user-caches', join(base, 'scan-absent')),
      target('npm-cache', join(base, 'scan-absent-2'), { granularity: 'whole' }),
    ])
    expect(report.items).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.totalBytes).toBe(0)
  })

  itNeedsPosixPermissions('records permission-degraded children as skipped without an item', async () => {
    const caches = join(base, 'scan-eacces-child')
    await put(join(caches, 'locked/inner'), 500)
    await chmod(join(caches, 'locked'), 0o000)
    try {
      const report = await scanJunk({}, [target('user-caches', caches)])
      expect(report.items).toEqual([])
      expect(report.skipped).toEqual([{ path: join(caches, 'locked'), reason: 'walk failed: EACCES' }])
    } finally {
      await chmod(join(caches, 'locked'), 0o700)
    }
  })
})

describe('validateJunkIds', () => {
  const home = '/Users/tester'
  let caches = ''

  beforeAll(async () => {
    caches = join(base, 'validate-caches')
    await put(join(caches, 'child/f'), 1)
  })

  it('rejects malformed ids and unregistered kinds whole-batch', async () => {
    for (const bad of ['noseparator', ':relative', `unknown:${caches}`, 'user-caches:relative/path', '']) {
      await expect(validateJunkIds([bad], [], home)).rejects.toMatchObject({ code: 'invalid_argument' })
    }
  })

  it('rejects literal escapes outside the kind root', async () => {
    const expanded = await expandGlobs([target('user-caches', caches)])
    await expect(validateJunkIds([`user-caches:${base}/elsewhere`], expanded, home)).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('rejects children-kind ids equal to the root but accepts whole-kind ids at the root', async () => {
    const childrenTargets = await expandGlobs([target('user-caches', caches)])
    await expect(validateJunkIds([`user-caches:${caches}`], childrenTargets, home)).rejects.toMatchObject({ code: 'invalid_argument' })
    const wholeTargets = await expandGlobs([target('npm-cache', caches, { granularity: 'whole' })])
    await expect(validateJunkIds([`npm-cache:${caches}`], wholeTargets, home)).resolves.toBeUndefined()
  })

  it('rejects symlink redirects that escape the root after realpath', async () => {
    const outside = join(base, 'validate-outside')
    await put(join(outside, 'secret'), 1)
    await linkDir(outside, join(caches, 'redirect'))
    const expanded = await expandGlobs([target('user-caches', caches)])
    await expect(validateJunkIds([`user-caches:${join(caches, 'redirect')}`], expanded, home))
      .rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('rejects blocked system paths even when a registry row would contain them', async () => {
    const misconfigured = await expandGlobs([
      target('user-caches', '/Library', { granularity: 'children' }),
      target('user-caches', `${home}/Library`, { granularity: 'children' }),
    ])
    await expect(validateJunkIds(['user-caches:/Library/AppSupport'], misconfigured, home)).rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds([`user-caches:${home}/Library/Containers/com.apple.x`], misconfigured, home))
      .rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds([`user-caches:${home}/Library/Caches/app`], misconfigured, home))
      .resolves.toBeUndefined()
    const homeRoot = await expandGlobs([target('user-caches', home, { granularity: 'whole' })])
    await expect(validateJunkIds([`user-caches:${home}`], homeRoot, home)).rejects.toMatchObject({ code: 'unsafe_target' })
  })

  it('rejects Linux red-line paths even when a registry row would contain them', async () => {
    const misconfigured = await expandGlobs([
      target('user-caches', '/etc', { granularity: 'children' }),
      target('user-caches', '/var/lib', { granularity: 'children' }),
      target('user-caches', '/lib', { granularity: 'children' }),
    ])
    await expect(validateJunkIds(['user-caches:/etc/app.conf'], misconfigured, home)).rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds(['user-caches:/var/lib/dpkg'], misconfigured, home)).rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds(['user-caches:/lib/modules/6.1.0-25-amd64'], misconfigured, home)).rejects.toMatchObject({ code: 'unsafe_target' })
  })

  it('blocks other users home trees on both layouts, and root home when it is not $HOME', () => {
    // /Users layout (macOS)
    expect(isBlockedPath('/Users/other/x', '/Users/tester')).toBe(true)
    expect(isBlockedPath('/Users/tester/x', '/Users/tester')).toBe(false)
    expect(isBlockedPath('/home/anyone/x', '/Users/tester')).toBe(true)
    // /home layout (Linux)
    expect(isBlockedPath('/home/other/x', '/home/tester')).toBe(true)
    expect(isBlockedPath('/home/tester/x', '/home/tester')).toBe(false)
    expect(isBlockedPath('/Users/anyone/x', '/home/tester')).toBe(true)
    // root's home
    expect(isBlockedPath('/root/x', '/home/tester')).toBe(true)
    expect(isBlockedPath('/root/x', '/root')).toBe(false)
    // shared system trees
    expect(isBlockedPath('/srv/data', '/home/tester')).toBe(true)
    expect(isBlockedPath('/boot/efi', '/home/tester')).toBe(true)
  })

  it('rejects kinds marked not safe to clean, with the suggested command in the message', async () => {
    const store = join(base, 'validate-pnpm')
    await put(join(store, 'v3/file'), 1)
    const expanded = await expandGlobs([target('pnpm-store', store, { safeToClean: false, rationale: 'Run `pnpm store prune` instead.' })])
    await expect(validateJunkIds([`pnpm-store:${store}/v3`], expanded, home))
      .rejects.toMatchObject({ code: 'unsafe_target', message: expect.stringContaining('pnpm store prune') })
  })
})

describe('cleanJunk', () => {
  it('rejects empty id lists', async () => {
    await expect(cleanJunk([], 'trash', [], { home: base })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('rejects mixed valid/invalid batches whole and touches nothing', async () => {
    const caches = join(base, 'clean-mixed')
    await put(join(caches, 'keep/f'), 64)
    const good = `user-caches:${join(caches, 'keep')}`
    const bad = `user-caches:${base}/outside`
    await expect(cleanJunk([good, bad], 'delete', [target('user-caches', caches)], { home: base }))
      .rejects.toMatchObject({ code: 'invalid_argument' })
    expect(existsSync(join(caches, 'keep', 'f'))).toBe(true)
  })

  it('prefers the trash utility tier and reports measured bytes', async () => {
    const caches = join(base, 'clean-tier1')
    await put(join(caches, 'item/f'), 256)
    const calls: string[][] = []
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home: base,
      io: {
        runTrashCommand: async paths => {
          calls.push([...paths])
          await rm(paths[0] as string, { recursive: true, force: true })
        },
      },
    })
    expect(calls).toEqual([[join(caches, 'item')]])
    expect(result.outcomes).toEqual([{ id: `user-caches:${join(caches, 'item')}`, reclaimedBytes: 256 }])
    expect(result.totalReclaimedBytes).toBe(256)
    expect(result.mode).toBe('trash')
    expect(existsSync(join(caches, 'item'))).toBe(false)
  })

  it('falls back to renaming into ~/.Trash with conflict suffixes (darwin)', async () => {
    const home = await freshHome('darwin')
    const caches = join(base, 'clean-tier2')
    await put(join(caches, 'item/f'), 128)
    await put(join(home, '.Trash', 'item', 'existing'), 1)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'darwin',
      io: noTrashBin,
    })
    expect(result.outcomes[0]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'item'))).toBe(false)
    expect(existsSync(join(home, '.Trash', 'item', 'existing'))).toBe(true)
    expect(existsSync(join(home, '.Trash', 'item 2', 'f'))).toBe(true)
    expect(result.totalReclaimedBytes).toBe(128)
  })

  it('moves into the freedesktop trash layout with a restore record and synced conflict suffix (linux)', async () => {
    const home = await freshHome('linux')
    const caches = join(base, 'clean-linux-tier2')
    await put(join(caches, 'item/f'), 128)
    // Occupy both faces of the name "item": a stale file in files/ and a
    // leftover record in info/ — the reservation must skip both.
    await put(join(home, '.local/share/Trash/files/item/stale'), 1)
    await put(join(home, '.local/share/Trash/info/item.trashinfo'), 40)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'linux',
      io: noTrashBin,
    })
    expect(result.outcomes[0]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'item'))).toBe(false)
    expect(existsSync(join(home, '.local/share/Trash/files/item 2/f'))).toBe(true)
    const record = await readFile(join(home, '.local/share/Trash/info/item 2.trashinfo'), 'utf8')
    expect(record).toContain('[Trash Info]')
    // The spec stores the original path percent-encoded, so a Windows path
    // legitimately carries %5C separators here.
    expect(record).toContain(`Path=${encodeURI(join(caches, 'item'))}`)
    expect(record).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)
    expect(result.totalReclaimedBytes).toBe(128)
  })

  it('copies and removes across volumes when rename throws EXDEV', async () => {
    const home = await freshHome('darwin')
    const caches = join(base, 'clean-tier3')
    await put(join(caches, 'item/f'), 512)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'darwin',
      io: {
        runTrashCommand: noTrashBin.runTrashCommand,
        rename: async () => {
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
        },
      },
    })
    expect(result.outcomes[0]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'item'))).toBe(false)
    expect(existsSync(join(home, '.Trash', 'item', 'f'))).toBe(true)
  })

  itNeedsPosixPermissions('refuses an unsafe ~/.Trash and leaves the item untouched', async () => {
    const home = await freshHome('darwin')
    await chmod(join(home, '.Trash'), 0o020)
    const caches = join(base, 'clean-badtrash')
    await put(join(caches, 'item/f'), 32)
    try {
      const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
        home,
        platform: 'darwin',
        io: noTrashBin,
      })
      expect(result.outcomes[0]?.reclaimedBytes).toBe(0)
      expect(result.outcomes[0]?.error).toContain('trash_failed')
      expect(existsSync(join(caches, 'item', 'f'))).toBe(true)
    } finally {
      await chmod(join(home, '.Trash'), 0o700)
    }
  })

  itNeedsPosixPermissions('refuses a group-writable freedesktop files face (linux)', async () => {
    const home = await freshHome('linux')
    const filesFace = join(home, '.local/share/Trash/files')
    await chmod(filesFace, 0o770)
    const caches = join(base, 'clean-linux-badtrash')
    await put(join(caches, 'item/f'), 32)
    try {
      const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
        home,
        platform: 'linux',
        io: noTrashBin,
      })
      expect(result.outcomes[0]?.reclaimedBytes).toBe(0)
      expect(result.outcomes[0]?.error).toContain('trash_failed')
      expect(existsSync(join(caches, 'item', 'f'))).toBe(true)
    } finally {
      await chmod(filesFace, 0o700)
    }
  })

  it('deletes recursively in delete mode and reports reclaimed bytes', async () => {
    const caches = join(base, 'clean-delete')
    await put(join(caches, 'item/f1'), 16)
    await put(join(caches, 'item/f2'), 32)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'delete', [target('user-caches', caches)], { home: base })
    expect(result.mode).toBe('delete')
    expect(result.outcomes).toEqual([{ id: `user-caches:${join(caches, 'item')}`, reclaimedBytes: 48 }])
    expect(existsSync(join(caches, 'item'))).toBe(false)
  })

  itNeedsPosixPermissions('refuses items whose re-measure is incomplete, leaving them untouched', async () => {
    const caches = join(base, 'clean-degraded-child')
    await put(join(caches, 'item/ok'), 16)
    await put(join(caches, 'item/locked/inner'), 999)
    await chmod(join(caches, 'item', 'locked'), 0o000)
    try {
      const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'delete', [target('user-caches', caches)], { home: base })
      expect(result.outcomes[0]?.reclaimedBytes).toBe(0)
      expect(result.outcomes[0]?.error).toContain('measure_failed')
      expect(existsSync(join(caches, 'item', 'ok'))).toBe(true)
    } finally {
      await chmod(join(caches, 'item', 'locked'), 0o700)
    }
    // existsSync cannot look inside a 0000 directory, so assert after restoring.
    expect(existsSync(join(caches, 'item', 'locked', 'inner'))).toBe(true)
  })

  it('reports vanished items as not_found without blocking the rest', async () => {
    const caches = join(base, 'clean-notfound')
    await put(join(caches, 'present/f'), 2)
    const result = await cleanJunk(
      [`user-caches:${join(caches, 'gone')}`, `user-caches:${join(caches, 'present')}`],
      'delete',
      [target('user-caches', caches)],
      { home: base },
    )
    expect(result.outcomes[0]).toEqual({ id: `user-caches:${join(caches, 'gone')}`, reclaimedBytes: 0, error: 'not_found' })
    expect(result.outcomes[1]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'present'))).toBe(false)
    expect(result.totalReclaimedBytes).toBe(2)
  })

  itNeedsPosixPermissions('skips items it cannot re-measure, leaving them untouched', async () => {
    const caches = join(base, 'clean-unmeasurable')
    await put(join(caches, 'item/inner'), 800)
    await chmod(join(caches, 'item'), 0o000)
    try {
      const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'delete', [target('user-caches', caches)], { home: base })
      expect(result.outcomes[0]?.reclaimedBytes).toBe(0)
      expect(result.outcomes[0]?.error).toContain('measure_failed')
      expect(existsSync(join(caches, 'item'))).toBe(true)
    } finally {
      await chmod(join(caches, 'item'), 0o700)
    }
  })

  it('empties the trash kind in place instead of moving it into itself (darwin)', async () => {
    const home = await freshHome('darwin')
    const trashDir = join(home, '.Trash')
    await put(join(trashDir, 'discarded/f'), 64)
    const trashCalls: string[][] = []
    const result = await cleanJunk([`trash:${trashDir}`], 'trash', [target('trash', trashDir, { granularity: 'whole' })], {
      home,
      platform: 'darwin',
      io: {
        runTrashCommand: async paths => {
          trashCalls.push([...paths])
        },
      },
    })
    expect(trashCalls).toEqual([])
    expect(result.outcomes).toEqual([{ id: `trash:${trashDir}`, reclaimedBytes: 64 }])
    expect(existsSync(trashDir)).toBe(true)
    expect(await readdir(trashDir)).toEqual([])
  })

  it('empties the linux trash layout in place, keeping files/ and info/ directories', async () => {
    const home = await freshHome('linux')
    const trashRoot = join(home, '.local/share/Trash')
    await put(join(trashRoot, 'files/discarded/f'), 64)
    await put(join(trashRoot, 'info/discarded.trashinfo'), 40)
    const trashCalls: string[][] = []
    const result = await cleanJunk([`trash:${trashRoot}`], 'trash', [target('trash', trashRoot, { granularity: 'whole' })], {
      home,
      platform: 'linux',
      io: {
        runTrashCommand: async paths => {
          trashCalls.push([...paths])
        },
      },
    })
    expect(trashCalls).toEqual([])
    expect(result.outcomes).toEqual([{ id: `trash:${trashRoot}`, reclaimedBytes: 104 }])
    expect(existsSync(join(trashRoot, 'files'))).toBe(true)
    expect(existsSync(join(trashRoot, 'info'))).toBe(true)
    expect(await readdir(join(trashRoot, 'files'))).toEqual([])
    expect(await readdir(join(trashRoot, 'info'))).toEqual([])
  })
})

describe('trash layout and tier-1 resolution', () => {
  it('maps the trash layout per platform', () => {
    expect(trashDirs('darwin', '/Users/t')).toEqual({ root: '/Users/t/.Trash', files: '/Users/t/.Trash', info: null })
    expect(trashDirs('linux', '/home/t')).toEqual({
      root: '/home/t/.local/share/Trash',
      files: '/home/t/.local/share/Trash/files',
      info: '/home/t/.local/share/Trash/info',
    })
    expect(trashDirs('win32', 'C:\\Users\\t')).toEqual({
      root: 'C:\\Users\\t\\AppData\\Local\\pc-manager\\trash',
      files: 'C:\\Users\\t\\AppData\\Local\\pc-manager\\trash',
      info: null,
    })
    expect(trashDirs('darwin', 'C:\\Users\\t')).toEqual({
      root: 'C:\\Users\\t\\.Trash',
      files: 'C:\\Users\\t\\.Trash',
      info: null,
    })
  })

  it('resolves no tier-1 trash utility on unsupported platforms', async () => {
    await expect(resolveTrashCommand('freebsd')).resolves.toBeNull()
    await expect(resolveTrashCommand('aix')).resolves.toBeNull()
  })
})

describe('describeJunkIds', () => {
  it('summarizes counts, distribution, and destination in both languages', () => {
    const ids = ['user-caches:/a/b', 'trash:/c', 'user-caches:/d']
    expect(describeJunkIds(ids, 'trash')).toEqual({
      en: 'Clean 3 items (user-caches ×2, trash ×1) → move to Trash. Recoverable until the Trash is emptied.',
      zh: '清理 3 项（user-caches ×2, trash ×1）→ 移入废纸篓，清空前可恢复。',
    })
  })

  it('handles single items, unknown ids, and delete mode', () => {
    expect(describeJunkIds(['bogus'], 'delete')).toEqual({
      en: 'Clean 1 item (unrecognized ×1) → permanent deletion. Not recoverable.',
      zh: '清理 1 项（unrecognized ×1）→ 永久删除，不可恢复。',
    })
  })
})
