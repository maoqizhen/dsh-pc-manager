/**
 * Windows junk-domain tests: the path-flavor layer that lets POSIX and
 * Windows literals coexist on any host (which is what makes the pinned
 * darwin/linux suites run unmodified on Windows), the Windows red lines, and
 * the Windows trash tiers. Fixtures live in tmpdirs with injected `home`,
 * `platform`, `env`, and `io` seams — no real Recycle Bin or system Temp is
 * ever touched here (the real-host round trip is in `e2e.win32.spec.ts`).
 * @module @deepseek-ai/dsh-pc-manager
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JUNK_TARGETS_WIN32, basenamePath, cleanJunk, isAbsolutePath, isBlockedPath, joinPath, normalizePath,
  parseJunkId, pathFlavor, resolveTargets, resolveTrashCommand, scanJunk, trashDirs, validateJunkIds,
  windowsBlockedPrefixes,
} from '../src/junk.ts'
import type { JunkTarget } from '../src/junk.ts'

let base = ''
let homeSeq = 0

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'pc-junk-win-'))
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** A Windows-flavored registry row, spelled with the host's separator so the
 * fixture is a real path on whichever host is running the suite. */
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
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 1))
}

/** A fresh fake Windows home with a safe fallback-trash layout. */
async function freshHome(): Promise<string> {
  homeSeq += 1
  const home = join(base, `win-home-${homeSeq}`)
  const dirs = trashDirs('win32', home)
  await mkdir(dirs.files, { recursive: true, mode: 0o700 })
  return home
}

/** io seam that forces the rename tier by making tier 1 fail. */
const noTrashBin = {
  runTrashCommand: async (_paths: readonly string[]) => {
    throw new Error('recycle utility unavailable in tests')
  },
}

/** A synthetic Windows environment: system drive D:, a relocated profile. */
const WIN_ENV = {
  SystemDrive: 'D:',
  SystemRoot: 'D:\\Windows',
  TEMP: 'D:\\Users\\t\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'D:\\Users\\t\\AppData\\Local',
  USERPROFILE: 'D:\\Users\\t',
  ProgramFiles: 'D:\\Program Files',
  'ProgramFiles(x86)': 'D:\\Program Files (x86)',
  ProgramData: 'D:\\ProgramData',
} as NodeJS.ProcessEnv

describe('path flavor handling', () => {
  it('classifies drive-absolute, UNC, and POSIX literals', () => {
    expect(pathFlavor('C:\\Users\\t')).toBe('win32')
    expect(pathFlavor('c:/users/t')).toBe('win32')
    expect(pathFlavor('\\\\server\\share\\x')).toBe('win32')
    expect(pathFlavor('/Users/t')).toBe('posix')
    expect(pathFlavor('relative')).toBe('posix')
    expect(pathFlavor('C:relative')).toBe('posix')
  })

  it('normalizes in the literal\'s own flavor, so a POSIX fixture survives a Windows host', () => {
    expect(normalizePath('/Users/t/.Trash')).toBe('/Users/t/.Trash')
    // A trailing separator is dropped — see the root-escape case below.
    expect(normalizePath('/Users/t/.Trash/')).toBe('/Users/t/.Trash')
    expect(normalizePath('C:\\Users\\t\\..\\t\\.Trash')).toBe('C:\\Users\\t\\.Trash')
    expect(normalizePath('C:/Users/t')).toBe('C:\\Users\\t')
    expect(normalizePath('C:\\Users\\t\\AppData\\Local\\Temp\\')).toBe('C:\\Users\\t\\AppData\\Local\\Temp')
    // Roots keep their separator.
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:\\')).toBe('C:\\')
  })

  it('joins in the base literal\'s flavor', () => {
    expect(joinPath('/home/t', '.cache')).toBe('/home/t/.cache')
    expect(joinPath('C:\\Users\\t', 'AppData/Local')).toBe('C:\\Users\\t\\AppData\\Local')
    expect(joinPath('/Users/t', 'Library', 'Caches')).toBe('/Users/t/Library/Caches')
  })

  it('recognizes absoluteness and basenames per flavor', () => {
    expect(isAbsolutePath('/etc')).toBe(true)
    expect(isAbsolutePath('C:\\Windows')).toBe(true)
    expect(isAbsolutePath('C:/Windows')).toBe(true)
    expect(isAbsolutePath('\\\\srv\\share')).toBe(true)
    expect(isAbsolutePath('etc/passwd')).toBe(false)
    expect(isAbsolutePath('C:Windows')).toBe(false)
    expect(basenamePath('C:\\Users\\t\\item')).toBe('item')
    expect(basenamePath('/Users/t/item')).toBe('item')
  })

  it('parses a Windows junk id without splitting on the drive colon', () => {
    expect(parseJunkId('trash:C:\\$Recycle.Bin')).toEqual({ kind: 'trash', path: 'C:\\$Recycle.Bin' })
    expect(parseJunkId('user-caches:C:/Users/t/AppData/Local/D3DSCache'))
      .toEqual({ kind: 'user-caches', path: 'C:/Users/t/AppData/Local/D3DSCache' })
    expect(parseJunkId('trash:C:relative')).toBeNull()
    expect(parseJunkId('trash:\\\\srv\\share\\x')).toEqual({ kind: 'trash', path: '\\\\srv\\share\\x' })
  })
})

describe('Windows red lines', () => {
  it('derives the system trees from the environment, not from a hard-coded C:', () => {
    const prefixes = windowsBlockedPrefixes(WIN_ENV)
    expect(prefixes).toContain('D:\\Windows')
    expect(prefixes).toContain('D:\\Program Files')
    expect(prefixes).toContain('D:\\Program Files (x86)')
    expect(prefixes).toContain('D:\\ProgramData')
    expect(prefixes).toContain('D:\\Recovery')
    expect(prefixes).not.toContain('C:\\Windows')
    // Conventional fallbacks still cover a stripped-down environment.
    expect(windowsBlockedPrefixes({} as NodeJS.ProcessEnv)).toContain('C:\\Windows')
  })

  it('blocks the system trees, the drive roots, and every other account tree', () => {
    const home = 'C:\\Users\\tester'
    expect(isBlockedPath('C:\\Windows\\System32\\drivers', home)).toBe(true)
    expect(isBlockedPath('c:\\windows\\temp\\x', home)).toBe(true)
    expect(isBlockedPath('C:\\Program Files\\App\\cache', home)).toBe(true)
    expect(isBlockedPath('C:\\ProgramData\\App', home)).toBe(true)
    expect(isBlockedPath('C:\\System Volume Information', home)).toBe(true)
    expect(isBlockedPath('C:\\Users\\Default\\x', home)).toBe(true)
    // Drive roots are never a reclaimable item.
    expect(isBlockedPath('C:\\', home)).toBe(true)
    expect(isBlockedPath('D:\\', home)).toBe(true)
    // The account root itself and other accounts' trees.
    expect(isBlockedPath('C:\\Users', home)).toBe(true)
    expect(isBlockedPath('C:\\Users\\other\\AppData\\Local\\Temp\\x', home)).toBe(true)
    // $HOME itself blocks equality only — its descendants are where junk lives.
    expect(isBlockedPath(home, home)).toBe(true)
    expect(isBlockedPath('C:\\Users\\tester\\AppData\\Local\\Temp\\x', home)).toBe(false)
    expect(isBlockedPath('C:\\Users\\tester2\\x', home)).toBe(true)
    expect(isBlockedPath('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001', home)).toBe(false)
  })

  it('honors a relocated system drive when judging a path', () => {
    expect(isBlockedPath('D:\\Windows\\Temp\\x', 'D:\\Users\\t', WIN_ENV)).toBe(true)
    expect(isBlockedPath('D:\\Users\\t\\AppData\\Local\\Temp\\x', 'D:\\Users\\t', WIN_ENV)).toBe(false)
  })

  it('keeps a home directory nested deeper than the account root cleanable', () => {
    const home = 'C:\\Users\\tester\\profiles\\dev'
    expect(isBlockedPath('C:\\Users\\tester\\profiles\\dev\\AppData\\Local\\Temp\\x', home)).toBe(false)
    expect(isBlockedPath('C:\\Users\\tester\\profiles\\other\\x', home)).toBe(false)
  })

  it('leaves POSIX literals to the POSIX rules', () => {
    expect(isBlockedPath('/etc/app.conf', '/Users/tester')).toBe(true)
    expect(isBlockedPath('/Users/tester/Library/Caches/app', '/Users/tester')).toBe(false)
  })
})

describe('Windows registry resolution', () => {
  it('expands %VAR% roots against a synthetic environment', () => {
    const rows = resolveTargets(JUNK_TARGETS_WIN32, 'D:\\Users\\t', WIN_ENV)
    expect(rows[0]?.dir).toBe('D:\\$Recycle.Bin')
    expect(rows[1]?.dir).toBe('D:\\Users\\t\\AppData\\Local\\Temp')
    expect(rows[2]?.dir).toBe('D:\\Windows\\Temp')
    expect(rows.at(-1)?.dir).toBe('D:\\Users\\t\\go\\pkg\\mod\\cache')
    for (const row of rows) expect(row.dir.includes('%')).toBe(false)
  })

  it('leaves an unknown placeholder verbatim rather than inventing a path', () => {
    const [row] = resolveTargets([target('npm-cache', '%NOPE%\\cache', { granularity: 'whole' })], 'D:\\Users\\t', WIN_ENV)
    expect(row?.dir).toBe('%NOPE%\\cache')
  })
})

describe('Windows trash layout and tier-1 resolution', () => {
  it('keeps the fallback holding directory inside the profile', () => {
    expect(trashDirs('win32', 'C:\\Users\\t')).toEqual({
      root: 'C:\\Users\\t\\AppData\\Local\\pc-manager\\trash',
      files: 'C:\\Users\\t\\AppData\\Local\\pc-manager\\trash',
      info: null,
    })
    // A POSIX home keeps a POSIX layout even when the platform is win32
    // (the flavor follows the home literal, not the host).
    expect(trashDirs('win32', '/home/t').root).toBe('/home/t/AppData/Local/pc-manager/trash')
  })

  it('resolves the PowerShell recycle command on a real Windows host', async () => {
    if (process.platform !== 'win32') {
      // Off Windows there is no interpreter to find; the contract is a null.
      await expect(resolveTrashCommand('win32')).resolves.toBeNull()
      return
    }
    const command = await resolveTrashCommand('win32')
    expect(command?.bin.toLowerCase()).toContain('powershell')
    const argv = command?.buildArgs(['C:\\Users\\t\\with space.txt', "C:\\Users\\t\\it's.txt"]) ?? []
    expect(argv.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-NoLogo', '-Command'])
    const script = argv.at(-1) ?? ''
    // The paths ride inside the script as literals: `-Command` re-joins argv
    // with spaces, which would split a path containing one.
    expect(script).toContain("'C:\\Users\\t\\with space.txt'")
    expect(script).toContain("'C:\\Users\\t\\it''s.txt'")
    expect(script).toContain('SendToRecycleBin')
    expect(script).toContain('Microsoft.VisualBasic')
    expect(script).toContain('no recycle targets were passed')
    expect(argv).toHaveLength(5)
  })
})

describe('Windows scan and validation', () => {
  it('gates on the injected platform instead of refusing win32 whole', async () => {
    await expect(scanJunk({ platform: 'win32' }, [])).resolves.toMatchObject({ items: [] })
    await expect(scanJunk({ platform: 'freebsd' }, [])).rejects.toMatchObject({ code: 'unsupported_platform' })
  })

  it('accepts children-kind descendants case-insensitively and rejects the root itself', async () => {
    const caches = join(base, 'win-validate', 'Temp')
    await put(join(caches, 'child', 'f'), 4)
    const expanded = [target('system-temp', caches)]
    await expect(validateJunkIds([`system-temp:${join(caches, 'child')}`], expanded, base)).resolves.toBeUndefined()
    await expect(validateJunkIds([`system-temp:${caches}`], expanded, base)).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(validateJunkIds([`system-temp:${base}\\win-validate\\elsewhere`], expanded, base))
      .rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses a blocked system path even when a registry row would contain it', async () => {
    await expect(validateJunkIds(['system-temp:C:\\Windows\\Temp\\installer.tmp'], [target('system-temp', 'C:\\Windows\\Temp')], 'C:\\Users\\t'))
      .rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds(['system-temp:C:\\Windows\\System32\\spool\\x'], [target('system-temp', 'C:\\Windows\\System32')], 'C:\\Users\\t'))
      .rejects.toMatchObject({ code: 'unsafe_target' })
    await expect(validateJunkIds(['system-temp:C:\\Program Files\\App\\cache\\f'], [target('system-temp', 'C:\\Program Files\\App')], 'C:\\Users\\t'))
      .rejects.toMatchObject({ code: 'unsafe_target' })
  })

  it('refuses a registry root spelled with a trailing separator (children-kind root escape)', async () => {
    const caches = join(base, 'win-trailing', 'Temp')
    await put(join(caches, 'child', 'f'), 4)
    const expanded = [target('system-temp', caches)]
    // `…/Temp/` names the root itself; treating it as "strictly under" would
    // empty the whole registry root through the children-kind path.
    await expect(validateJunkIds([`system-temp:${caches}\\`], expanded, base))
      .rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(validateJunkIds([`system-temp:${caches}/`], expanded, base))
      .rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses another account\'s tree and the Recycle Bin of a system SID', async () => {
    const home = 'C:\\Users\\tester'
    const binTargets = [target('trash', 'C:\\$Recycle.Bin')]
    const misconfigured = [target('user-caches', 'C:\\Users')]
    await expect(validateJunkIds(['user-caches:C:\\Users\\other\\AppData\\Local\\x'], misconfigured, home))
      .rejects.toMatchObject({ code: 'unsafe_target' })
    // The current account's own bin folder is legitimate.
    await expect(validateJunkIds(['trash:C:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001'], binTargets, home))
      .resolves.toBeUndefined()
  })

  it('scans a Windows-shaped fixture tree with per-child sizes', async () => {
    const tempRoot = join(base, 'win-scan', 'Temp')
    await put(join(tempRoot, 'old-app', 'a.bin'), 2048)
    await put(join(tempRoot, 'scoped_dir1234', 'installer.tmp'), 4096)
    const report = await scanJunk({ platform: 'win32' }, [target('system-temp', tempRoot)])
    expect(report.items.map(item => item.path).sort()).toEqual([
      join(tempRoot, 'old-app'),
      join(tempRoot, 'scoped_dir1234'),
    ])
    expect(report.totalBytes).toBe(6144)
    // The protection list runs even on a non-Windows host because the rule
    // names are data, not platform behaviour.
    const protectedReport = await scanJunk({ platform: 'win32' }, [
      target('system-temp', tempRoot, { protectedChildren: ['scoped_dir'] }),
    ])
    expect(protectedReport.items.map(item => item.label)).toEqual(['old-app'])
    expect(protectedReport.skipped).toEqual([
      { path: join(tempRoot, 'scoped_dir1234'), reason: 'protected child (rule: scoped_dir)' },
    ])
  })
})

describe('Windows clean', () => {
  it('runs the injected recycle tier and reports the measured bytes', async () => {
    const caches = join(base, 'win-clean-tier1')
    await put(join(caches, 'item', 'f'), 256)
    const calls: string[][] = []
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home: base,
      platform: 'win32',
      io: {
        runTrashCommand: async paths => {
          calls.push([...paths])
          await rm(paths[0] as string, { recursive: true, force: true })
        },
      },
    })
    expect(calls).toEqual([[join(caches, 'item')]])
    expect(result.outcomes).toEqual([{ id: `user-caches:${join(caches, 'item')}`, reclaimedBytes: 256 }])
    expect(existsSync(join(caches, 'item'))).toBe(false)
  })

  it('falls back to the profile holding directory with conflict suffixes', async () => {
    const home = await freshHome()
    const caches = join(base, 'win-clean-tier2')
    await put(join(caches, 'item', 'f'), 128)
    await put(join(home, 'AppData', 'Local', 'pc-manager', 'trash', 'item', 'existing'), 1)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'win32',
      io: noTrashBin,
    })
    expect(result.outcomes[0]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'item'))).toBe(false)
    expect(existsSync(join(home, 'AppData', 'Local', 'pc-manager', 'trash', 'item', 'existing'))).toBe(true)
    expect(existsSync(join(home, 'AppData', 'Local', 'pc-manager', 'trash', 'item 2', 'f'))).toBe(true)
    expect(result.totalReclaimedBytes).toBe(128)
  })

  it('vets the fallback faces structurally instead of demanding a POSIX owner uid', async () => {
    // Regression: the uid/mode gate used to reject every Windows face because
    // process.getuid() is undefined there.
    const home = await freshHome()
    const caches = join(base, 'win-clean-structural')
    await put(join(caches, 'item', 'f'), 32)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'win32',
      io: noTrashBin,
    })
    expect(result.outcomes[0]?.error).toBeUndefined()
    expect(existsSync(join(caches, 'item'))).toBe(false)
  })

  it('refuses a fallback face that is a file rather than a directory', async () => {
    // Deliberately not freshHome(): the holding path must not exist as a
    // directory when the file takes its place.
    homeSeq += 1
    const home = join(base, `win-home-file-${homeSeq}`)
    await put(join(home, 'AppData', 'Local', 'pc-manager', 'trash'), 8)
    const caches = join(base, 'win-clean-notdir')
    await put(join(caches, 'item', 'f'), 32)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'trash', [target('user-caches', caches)], {
      home,
      platform: 'win32',
      io: noTrashBin,
    })
    expect(result.outcomes[0]?.reclaimedBytes).toBe(0)
    expect(result.outcomes[0]?.error).toContain('trash_failed')
    expect(existsSync(join(caches, 'item', 'f'))).toBe(true)
  })

  it('empties the account Recycle Bin folder in place', async () => {
    const binDir = join(base, 'win-clean-bin', 'S-1-5-21-1-2-3-1001')
    await put(join(binDir, '$RABCDEF', 'f'), 64)
    await put(join(binDir, '$IABCDEF'), 200)
    const trashCalls: string[][] = []
    const result = await cleanJunk([`trash:${binDir}`], 'trash', [target('trash', binDir, { granularity: 'whole' })], {
      home: base,
      platform: 'win32',
      io: {
        runTrashCommand: async paths => {
          trashCalls.push([...paths])
        },
      },
    })
    expect(trashCalls).toEqual([])
    expect(result.outcomes).toEqual([{ id: `trash:${binDir}`, reclaimedBytes: 264 }])
    expect(existsSync(binDir)).toBe(true)
    expect(await readdir(binDir)).toEqual([])
  })

  it('deletes recursively in delete mode and reports reclaimed bytes', async () => {
    const caches = join(base, 'win-clean-delete')
    await put(join(caches, 'item', 'f1'), 16)
    await put(join(caches, 'item', 'f2'), 32)
    const result = await cleanJunk([`user-caches:${join(caches, 'item')}`], 'delete', [target('user-caches', caches)], {
      home: base,
      platform: 'win32',
    })
    expect(result.mode).toBe('delete')
    expect(result.outcomes).toEqual([{ id: `user-caches:${join(caches, 'item')}`, reclaimedBytes: 48 }])
    expect(existsSync(join(caches, 'item'))).toBe(false)
  })

  it('rejects a mixed batch whole, leaving the valid item untouched', async () => {
    const caches = join(base, 'win-clean-mixed')
    await put(join(caches, 'keep', 'f'), 64)
    await expect(cleanJunk(
      [`user-caches:${join(caches, 'keep')}`, `user-caches:${base}\\win-clean-outside`],
      'delete',
      [target('user-caches', caches)],
      { home: base, platform: 'win32' },
    )).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(existsSync(join(caches, 'keep', 'f'))).toBe(true)
  })
})
