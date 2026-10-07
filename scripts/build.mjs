#!/usr/bin/env node
/**
 * Build both committed artifacts into lib/ (host `index.js` + browser
 * `client.js`) by borrowing the harness toolchain — this package keeps no
 * node_modules of its own. Harness discovery: DSH_HARNESS_ROOT, then the
 * two supported checkout geometries (beside this repo, or one level up).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpathSync } from 'node:fs'
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
      && existsSync(path.join(root, 'node_modules/.bin/tsdown'))) return root
  }
  console.error(`[build] deepseek-harness checkout not found (tried: ${candidates.join(', ')}).`)
  console.error('[build] set DSH_HARNESS_ROOT to the harness root, or check it out beside this repo.')
  process.exit(1)
}

const harness = findHarness()
const tsdown = path.join(harness, 'node_modules/.bin/tsdown')
const config = path.join(pkgRoot, 'tsdown.config.ts')
const result = spawnSync(tsdown, ['--config', config], { stdio: 'inherit', cwd: harness })
process.exit(result.status ?? 1)
