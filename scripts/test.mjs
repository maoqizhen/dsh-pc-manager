#!/usr/bin/env node
/**
 * Run the vitest suite and the type check, both via the harness toolchain
 * (its vitest config only collects specs under packages/, so an external
 * project runs its binary with this package as --root; tsdown does no type
 * checking, so tsc is the only type gate).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

/**
 * The harness toolchain binary. pnpm/npm install `.bin/<name>` as an
 * extensionless shell script plus a `.cmd` shim on Windows — and a `.cmd`
 * cannot be launched without a shell, so the extension and the shell flag are
 * both platform-dependent.
 */
function toolBin(root, name) {
  const isWindows = process.platform === 'win32'
  return {
    path: path.join(root, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name),
    isWindows,
  }
}

function findHarness() {
  const candidates = [
    process.env.DSH_HARNESS_ROOT,
    path.resolve(pkgRoot, '../deepseek-harness'),
    path.resolve(pkgRoot, '../../deepseek-harness'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(path.join(root, 'package.json'))
      && existsSync(toolBin(root, 'vitest').path)) return root
  }
  console.error(`[test] deepseek-harness checkout not found (tried: ${candidates.join(', ')}).`)
  console.error('[test] set DSH_HARNESS_ROOT to the harness root, or check it out beside this repo.')
  process.exit(1)
}

const harness = findHarness()
const vitest = toolBin(harness, 'vitest')
const vitestResult = spawnSync(
  vitest.path,
  ['run', '--root', pkgRoot],
  { stdio: 'inherit', cwd: harness, shell: vitest.isWindows },
)
let tscStatus = 0
if (vitestResult.status === 0) {
  const tsc = toolBin(harness, 'tsc')
  const tscResult = spawnSync(
    tsc.path,
    ['--noEmit', '-p', path.join(pkgRoot, 'tsconfig.json')],
    { stdio: 'inherit', cwd: harness, shell: tsc.isWindows },
  )
  tscStatus = tscResult.status ?? 1
}
process.exit((vitestResult.status ?? 1) !== 0 ? vitestResult.status : tscStatus)
