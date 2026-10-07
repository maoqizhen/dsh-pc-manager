/**
 * Stage one of the client registration: what this package's two
 * `sidebar.right.pane.tab` tab types ARE. Both are page kinds like
 * files/terminal, opened from their guide entries beside Workspace files (10)
 * and New terminal (20) — System Monitor at order 30, Junk Cleanup at 31.
 */
import type { ComponentType, ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** The dashboard tab kind this package owns, and what `openTab` names. */
export const PC_MANAGER_KIND = 'pc-dashboard'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const PC_MANAGER_ID = '@deepseek-ai/dsh-pc-manager'

/** The junk-cleanup tab kind (§16.9): its own window beside System Monitor. */
export const JUNK_MANAGER_KIND = 'pc-junk'

/** Body seat key for the junk tab; unique from the dashboard's. */
export const JUNK_MANAGER_ID = '@deepseek-ai/dsh-pc-manager/junk'

/** Float-invocation signal: open the junk window and start scanning at once. */
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    'pc-junk': { readonly autoScan?: boolean }
  }
}

/** Self-drawn gauge glyph; the shared guide artworks cover only files/browser. */
function GuideArtworkGauge({ size = 36, className }: IconProps): ReactNode {
  const half = size / 2
  return (
    <svg width={size} height={size} viewBox='0 0 36 36' className={className} aria-hidden>
      <circle cx={half} cy={half} r={13} fill='none' stroke='currentColor' strokeOpacity={0.25} strokeWidth={4} />
      <path
        d='M 8.5 24.5 A 11 11 0 1 1 27.5 24.5'
        fill='none' stroke='currentColor' strokeOpacity={0.9} strokeWidth={4} strokeLinecap='round'
      />
      <line x1={half} y1={half} x2={22.5} y2={14} stroke='currentColor' strokeWidth={2.5} strokeLinecap='round' />
      <circle cx={half} cy={half} r={2} fill='currentColor' />
    </svg>
  )
}

/**
 * Self-drawn wastebasket glyph in the gauge's stroke language: round caps,
 * currentColor, the 0.9/0.25 opacity ladder for body versus interior.
 */
function GuideArtworkTrash({ size = 36, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox='0 0 36 36' className={className} aria-hidden>
      <path d='M 14 9.5 H 22' fill='none' stroke='currentColor' strokeOpacity={0.9} strokeWidth={3} strokeLinecap='round' />
      <path d='M 9.5 13.5 H 26.5' fill='none' stroke='currentColor' strokeOpacity={0.9} strokeWidth={3} strokeLinecap='round' />
      <path
        d='M 12 13.5 L 13.3 26.2 A 2.2 2.2 0 0 0 15.5 28.2 H 20.5 A 2.2 2.2 0 0 0 22.7 26.2 L 24 13.5'
        fill='none' stroke='currentColor' strokeOpacity={0.9} strokeWidth={3} strokeLinecap='round'
      />
      <path d='M 15.6 18.5 L 16.1 23.5' fill='none' stroke='currentColor' strokeOpacity={0.25} strokeWidth={2.5} strokeLinecap='round' />
      <path d='M 20.4 18.5 L 19.9 23.5' fill='none' stroke='currentColor' strokeOpacity={0.25} strokeWidth={2.5} strokeLinecap='round' />
    </svg>
  )
}

/**
 * The dashboard type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function pcManagerDefinition(t: TranslateNS<'pcManager'>): SidebarRightTabDefinition {
  return {
    id: PC_MANAGER_ID,
    kind: PC_MANAGER_KIND,
    title: () => t('type.label'),
    guide: [{
      id: 'dashboard',
      order: 30,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkGauge as ComponentType<IconProps>,
    }],
  }
}

/**
 * The junk-cleanup type's registry definition: its own full pane (§16.9),
 * opened from its guide entry or summoned by the floating monitor.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function junkManagerDefinition(t: TranslateNS<'pcManager'>): SidebarRightTabDefinition {
  return {
    id: JUNK_MANAGER_ID,
    kind: JUNK_MANAGER_KIND,
    title: () => t('junk.type.label'),
    guide: [{
      id: 'junk',
      order: 31,
      title: () => t('junk.guide.title'),
      description: () => t('junk.guide.description'),
      icon: GuideArtworkTrash as ComponentType<IconProps>,
    }],
  }
}
