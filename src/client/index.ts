/**
 * Browser half of the PC Manager: register the two right-Sidebar tab types —
 * System Monitor (guide order 30) and Junk Cleanup (order 31, its own
 * plan-and-clean pane, §16.9) — their keyed bodies in the
 * `sidebar.right.pane.tab` seat, and the floating monitor in the shell's
 * overlay layer. Data flows from the same package's host half over
 * `GET /pc-manager/status`, `GET /pc-manager/junk/scan`, and
 * `POST /pc-manager/junk/clean`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only imports: they carry the Context augmentations (locale/slots/tab
// registries/sidebar controller/shell overlay) and are erased from the bundle
// — the only runtime imports are react.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { bindJunkCleanup } from './cleanup.ts'
import { JUNK_MANAGER_ID, JUNK_MANAGER_KIND, PC_MANAGER_ID, junkManagerDefinition, pcManagerDefinition } from './definition.tsx'
import { DashboardBody } from './DashboardBody.tsx'
import { FloatingMonitor } from './float.tsx'
import { JunkBody } from './JunkBody.tsx'
import { en, zh } from './locales.ts'
import { ensureStyles } from './styles.ts'

/** This package's copy namespace. */
const NS = 'pcManager'

/** Required browser services: the registries, the keyed seats, copy, and the
 * sidebar controller the floating monitor summons the junk window through. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/**
 * Client plugin body: register the dictionaries, both tab types, their keyed
 * bodies, and the floating overlay.
 * @param ctx - client root context carrying the registries, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  // Styles before any surface: the floating widget renders in the shell
  // overlay whether or not either tab is ever mounted.
  ensureStyles()
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pc-manager: dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(pcManagerDefinition(t)), 'pc-manager: tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register(junkManagerDefinition(t)), 'pc-manager: junk tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: PC_MANAGER_ID, locale: NS },
    DashboardBody,
  )), 'pc-manager: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: JUNK_MANAGER_ID, locale: NS },
    JunkBody,
  )), 'pc-manager: junk tab body')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'pc-manager.float', locale: NS },
    FloatingMonitor,
  )), 'pc-manager: float overlay')
  // The float's cleanup row summons the junk window; openTab is idempotent
  // (opens + expands, or focuses) and bumps the navigation revision so the
  // body rescans on every summons.
  bindJunkCleanup(() => ctx.sidebarRight.openTab(JUNK_MANAGER_KIND, { params: { autoScan: true } }))
}
