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

function findHarness() {
  const candidates = [
    process.env.DSH_HARNESS_ROOT,
    path.resolve(pkgRoot, '../deepseek-harness'),
    path.resolve(pkgRoot, '../../deepseek-harness'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(path.join(root, 'package.json'))
      && existsSync(path.join(root, 'node_modules/.bin/vitest'))) return root
  }
  console.error(`[test] deepseek-harness checkout not found (tried: ${candidates.join(', ')}).`)
  console.error('[test] set DSH_HARNESS_ROOT to the harness root, or check it out beside this repo.')
  process.exit(1)
}

const harness = findHarness()
const vitest = spawnSync(
  path.join(harness, 'node_modules/.bin/vitest'),
  ['run', '--root', pkgRoot],
  { stdio: 'inherit', cwd: harness },
)
let tscStatus = 0
if (vitest.status === 0) {
  const tsc = spawnSync(
    path.join(harness, 'node_modules/.bin/tsc'),
    ['--noEmit', '-p', path.join(pkgRoot, 'tsconfig.json')],
    { stdio: 'inherit', cwd: harness },
  )
  tscStatus = tsc.status ?? 1
}
process.exit((vitest.status ?? 1) !== 0 ? vitest.status : tscStatus)
