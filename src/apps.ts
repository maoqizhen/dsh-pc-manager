/**
 * Installed-software inventory and uninstall (软件卸载). macOS sources: app
 * bundles under /Applications (+ ~/Applications), and Homebrew formulae/casks.
 * Uninstall is M3 and will default to moving the bundle to Trash with the
 * related plists/caches reported as leftovers rather than silently deleted.
 * @module @deepseek-ai/dsh-pc-manager
 */

import type { AppInventory, AppUninstallResult } from './types.ts'
import { PcManagerError } from './types.ts'

/** Directories scanned for `*.app` bundles. */
export const APP_BUNDLE_DIRS = ['/Applications', '~/Applications'] as const

/**
 * Enumerate uninstallable apps with sizes and last-launch times.
 * TODO(M3): /Applications + ~/Applications bundle walk (du + Spotlight
 * kMDItemLastUseDate), plus `brew list --formula --cask` merging.
 */
export async function listApps(): Promise<AppInventory> {
  throw new PcManagerError('not_implemented', 'app inventory lands in M3; the source list is ready for review.')
}

/**
 * Uninstall one app by its inventory id.
 * TODO(M3): bundle → Trash first (recoverable); hard delete and `brew
 * uninstall` behind config; report plists and app-support dirs as leftovers.
 */
export async function uninstallApp(_id: string, _mode: 'trash' | 'delete'): Promise<AppUninstallResult> {
  throw new PcManagerError('not_implemented', 'app uninstall lands in M3; nothing was removed.')
}
