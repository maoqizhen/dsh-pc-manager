#!/usr/bin/env node
/**
 * One-time dev setup: link this package into a dsh profile's node_modules
 * under its package name (the resolution channel for out-of-tree plugins —
 * the loader's linkedRoots and the browser client-modules scan both resolve
 * by name), then build lib/ with the harness toolchain. Idempotent.
 *
 * Usage: node scripts/dev-setup.mjs [--profile web] [--dsh-home ~/.dsh]
 *
 * Afterwards run the host from the harness repository root:
 *   pnpm dsh --patch <this-repo>/cordis.patch.yml --profile <profile>
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')
    ? args[index + 1]
    : fallback
}

const profile = arg('profile', 'web')
const dshHome = arg('dsh-home', path.join(homedir(), '.dsh'))
const pkgRoot = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const pkgName = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).name

const target = path.join(dshHome, 'profiles', profile, 'node_modules', pkgName)
mkdirSync(path.dirname(target), { recursive: true })

if (existsSync(target)) {
  if (!lstatSync(target).isSymbolicLink()) {
    console.error(`[dev-setup] ${target} exists and is not a symlink.`)
    console.error('[dev-setup] a stale copy there would shadow the source — remove it and re-run.')
    process.exit(1)
  }
  rmSync(target)
}
symlinkSync(pkgRoot, target, 'dir')
console.log(`[dev-setup] linked ${target} -> ${pkgRoot}`)

const build = spawnSync(process.execPath, [path.join(pkgRoot, 'scripts/build.mjs')], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

console.log(`[dev-setup] done. Run the host from the harness repository root:
  pnpm dsh --patch ${path.join(pkgRoot, 'cordis.patch.yml')} --profile ${profile}`)
