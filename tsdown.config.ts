/**
 * Standalone dual-artifact build for this out-of-repository plugin package.
 *
 * The in-repo preset (`packages/client/tsdown.client.ts`) hard-codes the
 * harness repository root for its isolation and externals resolution, so an
 * external package replicates the artifact contract by hand instead. Two
 * entries share lib/:
 *
 * - host `lib/index.js` (ESM): `src/index.ts` bundled with every
 *   `@deepseek-ai/*` and `node:*` import kept external — at runtime the
 *   packages resolve through the dsh host / profile installation. Committed
 *   to the repository so a git install loads without any build step.
 * - client `lib/client.js` (CJS): a factory whose banner/footer hand the
 *   module to `window.__ModuleLoader__.load({ id, factory: (require) => … })`;
 *   externals limited to the shared browser module table rows this package
 *   imports at runtime (react and its JSX runtime; every `@deepseek-ai/*`
 *   import in the sources is type-only and erased); no CSS pipeline — styles
 *   ship as a runtime-injected <style> tag.
 *
 * Run via `npm run build` (scripts/build.mjs locates the harness toolchain),
 * or directly from the harness root:
 *   node_modules/.bin/tsdown --config ../dsh-pc-manager/tsdown.config.ts
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The build runs from the plugin directory, where no node_modules exists;
 * resolve build tooling through the harness checkout. Discovery order:
 * an explicit DSH_HARNESS_ROOT, then the two supported geometries — this
 * repository checked out beside the harness, or nested one level deeper
 * inside a parent workspace directory. */
function resolveHarnessRoot(): string {
  const candidates: (string | undefined)[] = [
    process.env.DSH_HARNESS_ROOT,
    '../deepseek-harness',
    '../../deepseek-harness',
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const root = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(root)) return root
  }
  throw new Error(
    '[tsdown] deepseek-harness checkout not found '
    + '(tried DSH_HARNESS_ROOT, ../deepseek-harness, ../../deepseek-harness). '
    + 'Set DSH_HARNESS_ROOT to the harness root.',
  )
}

const HARNESS_ROOT = resolveHarnessRoot()

type ConfigObject = Record<string, unknown>
type DefineConfig = (config: ConfigObject | ConfigObject[]) => ConfigObject | ConfigObject[]
const { defineConfig } = createRequire(`${HARNESS_ROOT}/package.json`)('tsdown') as {
  defineConfig: DefineConfig
}

const PKG_ID = 'dsh-pc-manager'

/** Host-side external: anything resolved from the dsh runtime, never bundled. */
const isHostExternal = (specifier: string): boolean =>
  specifier.startsWith('node:') || specifier.startsWith('@deepseek-ai/')

/** Module-table rows the browser bundle may `require`. */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
])

const hostConfig = {
  name: `${PKG_ID}/host`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: isHostExternal,
    alwaysBundle: (specifier: string) => !isHostExternal(specifier),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

const clientConfig = {
  name: `${PKG_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier) && !specifier.startsWith('node:'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
  },
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n`
    + 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
}

export default defineConfig([hostConfig, clientConfig])
