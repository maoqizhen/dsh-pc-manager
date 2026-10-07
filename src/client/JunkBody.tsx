/**
 * The junk-cleanup tab's body (§16.9): the whole plan — scan, kind selection,
 * confirmation, execution, brief — as one full pane with zero LLM
 * round-trips. Kinds are the selection unit (a screenful of rows, never a
 * wall of checkboxes); per-item detail stays folded inside each kind's
 * disclosure for surgical edits. The confirm strip is the dashboard-side
 * counterpart of the tool path's approval gate: unconditional, one extra
 * explicit click, destination and recoverability spelled out.
 *
 * Navigation params carry the float's summons: `{ autoScan: true }` starts a
 * scan on mount and again on every repeated openTab (the navigation revision
 * increments each time, even with identical params).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import { fetchJunkPlan, formatBytes, postJunkClean } from './face.ts'
import type { JunkCleanResultWire, JunkPlanItem, JunkPlanResponse } from './face.ts'

/** The body's composed props: the tab it draws and its copy. */
export type JunkBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'pcManager'>

type PlanPhase =
  | { readonly type: 'idle' }
  | { readonly type: 'scanning' }
  | { readonly type: 'plan', readonly data: JunkPlanResponse }
  | { readonly type: 'done', readonly data: JunkPlanResponse, readonly result: JunkCleanResultWire }
  | { readonly type: 'error', readonly message: string }

/** One kind group in the plan, with the selection derived from `checked`. */
interface PlanGroup {
  readonly kind: string
  readonly label: string
  readonly safeToClean: boolean
  readonly recommended: boolean
  readonly rationale: string
  readonly items: readonly JunkPlanItem[]
  readonly totalBytes: number
  readonly checkedCount: number
}

function buildGroups(data: JunkPlanResponse, checked: ReadonlySet<string>): readonly PlanGroup[] {
  const metaByKind = new Map(data.kindMeta.map(meta => [meta.kind, meta]))
  const itemsByKind = new Map<string, JunkPlanItem[]>()
  for (const item of data.items) {
    const list = itemsByKind.get(item.kind) ?? []
    list.push(item)
    itemsByKind.set(item.kind, list)
  }
  return [...itemsByKind.entries()]
    .map(([kind, items]) => {
      const meta = metaByKind.get(kind)
      return {
        kind,
        label: meta?.label ?? kind,
        safeToClean: meta?.safeToClean ?? true,
        recommended: meta?.recommended ?? false,
        rationale: meta?.rationale ?? '',
        items,
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        checkedCount: items.reduce((count, item) => count + (checked.has(item.id) ? 1 : 0), 0),
      }
    })
    .sort((left, right) => right.totalBytes - left.totalBytes)
}

/** Muted preview of a kind's biggest entries: the "affected apps" glance line. */
function groupPreview(group: PlanGroup, t: TranslateNS<'pcManager'>): string {
  const names = group.items.slice(0, 2).map(item => item.label)
  if (group.items.length > 2) {
    return `${names.join(' · ')} ${t('cleanup.previewMore', { count: group.items.length - 2 })}`
  }
  return names.join(' · ')
}

/** The keyed tab body: summonable plan-and-clean pane. */
export function JunkBody(props: JunkBodyProps): ReactNode {
  const { t, useTabInfo } = props
  const { tab } = useTabInfo()
  const [phase, setPhase] = useState<PlanPhase>({ type: 'idle' })
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [cleanError, setCleanError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const runScan = useCallback((): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({ type: 'scanning' })
    setConfirming(false)
    setCleanError(null)
    fetchJunkPlan(controller.signal)
      .then(data => {
        setPhase({ type: 'plan', data })
        setChecked(new Set(data.items.filter(item => item.recommendedDefault).map(item => item.id)))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setPhase({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [])

  // The float summons with { autoScan: true }: scan on first mount and again
  // on every repeated openTab — the navigation revision bumps each time.
  const navRevision = tab.navigation.revision
  const navParams = tab.navigation.params
  useEffect(() => {
    if (navParams?.autoScan === true) runScan()
  }, [navRevision, navParams, runScan])

  // An abandoned tab must not leave a scan or a clean running against the host.
  useEffect(() => () => abortRef.current?.abort(), [])

  const groups = useMemo(
    () => phase.type === 'plan' ? buildGroups(phase.data, checked) : [],
    [phase, checked],
  )
  const selected = useMemo(
    () => phase.type === 'plan'
      ? phase.data.items.reduce((acc, item) =>
        checked.has(item.id) ? { count: acc.count + 1, bytes: acc.bytes + item.sizeBytes } : acc,
      { count: 0, bytes: 0 })
      : { count: 0, bytes: 0 },
    [phase, checked],
  )

  const toggleItem = (id: string): void => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleGroup = (group: PlanGroup): void => {
    setChecked(prev => {
      const next = new Set(prev)
      const allOn = group.checkedCount === group.items.length
      for (const item of group.items) {
        if (allOn) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }
  const toggleDisclosure = (kind: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const execute = (): void => {
    if (phase.type !== 'plan') return
    const ids = phase.data.items.filter(item => checked.has(item.id)).map(item => item.id)
    const controller = new AbortController()
    abortRef.current = controller
    setExecuting(true)
    setCleanError(null)
    postJunkClean(ids, controller.signal)
      .then(result => {
        setExecuting(false)
        setConfirming(false)
        setPhase({ type: 'done', data: phase.data, result })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setExecuting(false)
        setCleanError(error instanceof Error ? error.message : String(error))
      })
  }

  const head = (onRescan: boolean): ReactNode => (
    <div className='pc-manager-junk-head'>
      <span className='pc-manager-host'>{t('junk.type.label')}</span>
      {onRescan && (
        <button type='button' className='pc-action-pill' onClick={runScan}>{t('cleanup.rescan')}</button>
      )}
    </div>
  )

  if (phase.type === 'done') {
    const { data, result } = phase
    const kindOf = new Map(data.items.map(item => [item.id, item] as const))
    const failed = result.outcomes.filter(outcome => outcome.error !== undefined)
    const byKind = new Map<string, { bytes: number, failed: number }>()
    for (const outcome of result.outcomes) {
      const meta = kindOf.get(outcome.id)
      const key = meta?.kind ?? '—'
      const agg = byKind.get(key) ?? { bytes: 0, failed: 0 }
      if (outcome.error === undefined) agg.bytes += outcome.reclaimedBytes
      else agg.failed += 1
      byKind.set(key, agg)
    }
    return (
      <div className='pc-manager-junk'>
        {head(true)}
        <span className='pc-manager-host'>{t('cleanup.doneTitle', { size: formatBytes(result.totalReclaimedBytes) })}</span>
        <span className='pc-manager-group-note'>
          {result.mode === 'trash' ? t('cleanup.doneNoteTrash') : t('cleanup.doneNoteDelete')}
        </span>
        <div className='pc-manager-plan-groups'>
          {[...byKind.entries()].map(([kind, agg]) => {
            const meta = data.kindMeta.find(candidate => candidate.kind === kind)
            return (
              <div key={kind} className='pc-manager-group'>
                <div className='pc-manager-group-head'>
                  <span className='pc-manager-group-title'>{meta?.label ?? kind}</span>
                  <span className='pc-manager-group-bytes'>
                    {agg.failed > 0
                      ? t('cleanup.failedCount', { count: agg.failed })
                      : formatBytes(agg.bytes)}
                  </span>
                </div>
              </div>
            )
          })}
          {failed.map(outcome => {
            const meta = kindOf.get(outcome.id)
            return (
              <div key={outcome.id} className='pc-manager-item' data-disabled='true'>
                <span className='pc-manager-item-name' title={outcome.error}>{meta?.label ?? outcome.id}</span>
                <span className='pc-manager-item-bytes' title={outcome.error}>{outcome.error}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  if (phase.type === 'plan') {
    const destination = phase.data.moveToTrash ? t('cleanup.destinationTrash') : t('cleanup.destinationDelete')
    return (
      <div className='pc-manager-junk'>
        {head(true)}
        <span className='pc-manager-plan-hint'>{t('cleanup.planHint')}</span>
        {confirming && !executing && (
          <div className='pc-manager-confirm' role='alertdialog' aria-label={t('cleanup.confirmYes')}>
            <span className='pc-manager-confirm-title'>
              {t('cleanup.confirmTitle', { count: selected.count, size: formatBytes(selected.bytes), destination })}
            </span>
            <div className='pc-manager-confirm-actions'>
              <button type='button' className='pc-action-pill' onClick={() => setConfirming(false)}>{t('cleanup.cancel')}</button>
              <button type='button' className='pc-action-pill' data-primary='true' onClick={execute}>{t('cleanup.confirmYes')}</button>
            </div>
          </div>
        )}
        {cleanError !== null && (
          <span className='pc-manager-group-note' data-tone='error'>{t('cleanup.cleanError', { message: cleanError })}</span>
        )}
        <div className='pc-manager-plan-groups'>
          {groups.map(group => {
            const open = expanded.has(group.kind)
            const indeterminate = group.checkedCount > 0 && group.checkedCount < group.items.length
            return (
              <div key={group.kind} className='pc-manager-group'>
                <div className='pc-manager-group-head'>
                  {group.safeToClean ? (
                    <input
                      type='checkbox'
                      aria-label={group.kind}
                      ref={el => { if (el !== null) el.indeterminate = indeterminate }}
                      checked={group.checkedCount === group.items.length}
                      onChange={() => toggleGroup(group)}
                    />
                  ) : <span className='pc-manager-group-spacer' />}
                  <span className='pc-manager-group-title' title={group.rationale}>{group.label}</span>
                  <span className='pc-manager-group-bytes'>{formatBytes(group.totalBytes)}</span>
                </div>
                <div className='pc-manager-group-sub'>
                  <span className='pc-manager-group-preview'>{groupPreview(group, t)}</span>
                  {group.safeToClean && (
                    <button type='button' className='pc-manager-disclosure' aria-expanded={open}
                      onClick={() => toggleDisclosure(group.kind)}>
                      {t('cleanup.detail', { count: group.items.length })}{open ? ' ▴' : ' ▸'}
                    </button>
                  )}
                </div>
                {!group.safeToClean && (
                  <span className='pc-manager-group-note'>{t('cleanup.manualOnly')} · {group.rationale}</span>
                )}
                {group.safeToClean && !group.recommended && (
                  <span className='pc-manager-group-note'>{t('cleanup.nonRegenerable')}</span>
                )}
                {open && (
                  <div className='pc-manager-itemlist'>
                    {group.items.map(item => (
                      <label key={item.id} className='pc-manager-item'>
                        <input
                          type='checkbox'
                          aria-label={item.id}
                          checked={checked.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                        />
                        <span className='pc-manager-item-name' title={item.path}>{item.label}</span>
                        <span className='pc-manager-item-bytes'>{formatBytes(item.sizeBytes)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className='pc-manager-plan-foot'>
          <span className='pc-manager-plan-sum' data-empty={selected.count === 0}>
            {selected.count === 0
              ? t('cleanup.planHint')
              : t('cleanup.selected', { count: selected.count, size: formatBytes(selected.bytes) })}
          </span>
          {executing
            ? <button type='button' className='pc-action-pill' disabled aria-busy='true'>{t('cleanup.executing')}</button>
            : (
                <button
                  type='button'
                  className='pc-action-pill'
                  data-primary='true'
                  disabled={selected.count === 0}
                  onClick={() => setConfirming(true)}
                >
                  {t('cleanup.clean')}
                </button>
              )}
        </div>
      </div>
    )
  }

  return (
    <div className='pc-manager-junk'>
      {head(false)}
      <div className='pc-manager-junk-lead'>
        <span className='pc-manager-cleanup-hint'>
          {phase.type === 'error' ? t('cleanup.scanError', { message: phase.message }) : t('cleanup.hint')}
        </span>
        <button
          type='button'
          className='pc-action-pill'
          onClick={runScan}
          disabled={phase.type === 'scanning'}
          aria-busy={phase.type === 'scanning'}
        >
          {phase.type === 'error' ? t('error.retry') : t('cleanup.scan')}
        </button>
      </div>
      {phase.type === 'scanning' && <div className='pc-manager-sk pc-manager-junk-sk' aria-hidden />}
    </div>
  )
}
