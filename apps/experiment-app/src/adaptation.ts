import { z } from 'zod'

export const experimentModeSchema = z.enum(['normal', 'automatic'])
export type ExperimentMode = z.infer<typeof experimentModeSchema>
export const displayStateSchema = z.enum(['stationary', 'walking', 'running'])
const state = z.enum(['stationary', 'walking', 'running', 'unknown'])
const time = z.number().finite().nonnegative()
const profile = z.strictObject({ rowHeightPx: z.number().finite().positive(), fontSizePx: z.number().finite().positive() })
export const uiConfigSchema = z.strictObject({
  unknownHoldMs: time, maximumEstimateAgeMs: z.number().finite().positive(),
  profiles: z.strictObject({ stationary: profile, walking: profile, running: profile }),
})
// Rehearsal settings. CSS may constrain row height to the fixed slots on small viewports.
export const uiConfig = uiConfigSchema.parse({ unknownHoldMs: 1000, maximumEstimateAgeMs: 600,
  profiles: { stationary: { rowHeightPx: 56, fontSizePx: 16 }, walking: { rowHeightPx: 64, fontSizePx: 20 }, running: { rowHeightPx: 72, fontSizePx: 24 } } })
export const uiDecisionSchema = z.strictObject({
  decidedAtMs: time, estimateAtMs: time.nullable(), inputState: state,
  state: displayStateSchema, reason: z.enum(['fixed', 'initial', 'estimated', 'unknown-hold', 'unknown-fallback']), stale: z.boolean(),
})
export const presentationMetricsSchema = z.strictObject({
  rowHeightPx: z.number().finite().positive().nullable(), fontSizePx: z.number().finite().positive().nullable(),
  viewportHeightPx: z.number().finite().positive(),
})
export interface RenderedTaskContext { readonly phase: string; readonly decisionKey: string; readonly selectedTrainIndex: number | null }
export type PresentationMetrics = z.infer<typeof presentationMetricsSchema>
export const uiLogSchema = z.strictObject({
  ...uiDecisionSchema.shape, appliedAtMs: time, appliedState: displayStateSchema,
  phase: z.enum(['briefing', 'preparing', 'viewing', 'waiting-stop', 'answering', 'complete', 'aborted']),
  surface: z.enum(['information', 'common']), metrics: presentationMetricsSchema.nullable(),
})
export const stateLabels = { stationary: '静止', walking: '歩行', running: '走行', unknown: '推定不能' }
export const displayLabels = { stationary: '通常表示', walking: '歩行向け', running: '走行向け' }
export const adaptationReasonLabels = {
  fixed: '固定条件', initial: '有効な推定待ち', estimated: '安定化後の推定に追従',
  'unknown-hold': '推定不能中の表示維持', 'unknown-fallback': '推定不能が続いたため通常表示',
}
