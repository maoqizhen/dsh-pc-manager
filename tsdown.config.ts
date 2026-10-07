/**
 * Standalone client-bundle build for an out-of-repository plugin package.
 *
 * The in-repo preset (`packages/client/tsdown.client.ts`) hard-codes the
 * harness repository root for its isolation and externals resolution, so an
 * external package replicates the artifact contract by hand instead:
 *
 * - CJS entry at `lib/client.js` whose factory banner/footer hand the module
 *   to `window.__ModuleLoader__.load({ id, factory: (require) => ... })`;
 * - externals limited to the shared browser module table rows this package
 *   actually imports at runtime (react and its JSX runtime; every
 *   `@deepseek-ai/*` import in the sources is type-only and erased);
 * - no CSS pipeline: styles ship as a runtime-injected <style> tag.
 *
 * Run from the harness root (the toolchain anchor, as with vitest; this repo
 * is expected checked out side by side with it):
 *   node_modules/.bin/tsdown --config ../dsh-pc-manager/tsdown.config.ts
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** The config runs from the plugin directory, where no node_modules exists;
 * resolve build tooling through the harness root, the same anchor the cordis
 * patch uses. Derived relative to this file: the harness checkout is a
 * sibling of this repository. */
const HARNESS_ROOT = fileURLToPath(new URL('../../deepseek-harness', import.meta.url))

type DefineConfig = (config: Record<string, unknown>) => Record<string, unknown>
const { defineConfig } = createRequire(`${HARNESS_ROOT}/package.json`)('tsdown') as {
  defineConfig: DefineConfig
}

const PKG_ID = '@deepseek-ai/dsh-pc-manager'

/** Module-table rows the bundle may `require` in the browser. */
const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
])

export default defineConfig({
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
    neverBundle: (specifier: string) => EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !EXTERNALS.has(specifier) && !specifier.startsWith('node:'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
  },
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n`
    + 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
})
