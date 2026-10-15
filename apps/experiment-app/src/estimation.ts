import { z } from 'zod'
import type { EstimationConfig, MotionEstimate } from '@physical-adaptive/device-motion'

/** Rehearsal settings, not validated main-experiment parameters. */
export const estimationConfig: EstimationConfig = Object.freeze({
  windowMs: 1000, updateIntervalMs: 200, stationaryThreshold: 0.8, runningThreshold: 3.4,
  stableDurationMs: 400, minimumValidSamples: 40, maximumValidGapMs: 100, maximumUpdateGapMs: 600,
  stationaryWindowMs: 400,
})
const time = z.number().finite().nonnegative()
const positive = z.number().finite().positive()
const state = z.enum(['stationary', 'walking', 'running', 'unknown'])
export const estimationConfigSchema = z.strictObject({
  windowMs: positive, updateIntervalMs: positive, stationaryThreshold: positive, runningThreshold: positive,
  stableDurationMs: positive, minimumValidSamples: z.int().positive(), maximumValidGapMs: positive, maximumUpdateGapMs: positive,
  stationaryWindowMs: positive.optional(),
}).superRefine((value, context) => {
  // Keep wire validation independent of sensor implementation during Vite config loading.
  if (value.stationaryThreshold >= value.runningThreshold || value.maximumUpdateGapMs < value.updateIntervalMs
    || (value.stationaryWindowMs !== undefined && value.stationaryWindowMs > value.windowMs)) {
    context.addIssue({ code: 'custom', message: '推定設定の閾値・時間間隔の順序が不正です。' })
  }
})
const statistics = z.strictObject({
  validCount: z.int().positive(), mean: time, standardDeviation: time, rootMeanSquare: time, range: time,
}).nullable()
const featuresSchema = z.strictObject({
  startAtMs: z.number().finite(), endAtMs: time, sampleCount: z.int().nonnegative(),
  firstSampleAtMs: time.nullable(), lastSampleAtMs: time.nullable(), maximumGapMs: time,
  acceleration: statistics, accelerationIncludingGravity: statistics,
})
export const estimateSchema = z.strictObject({
  evaluatedAtMs: time, classifiedAtMs: time, stabilizedAtMs: time,
  classifiedState: state, stabilizedState: state, candidateState: state, candidateSinceMs: time.nullable(),
  classificationReason: z.enum(['warming-up', 'insufficient-data', 'data-gap', 'rms-threshold', 'short-window-stationary']),
  stabilizationReason: z.enum(['unknown', 'pending', 'accepted', 'unchanged']), updateGap: z.boolean(), maximumValidGapMs: time,
  features: featuresSchema,
  stationaryFeatures: featuresSchema.optional(), stationaryMaximumValidGapMs: time.optional(),
}).superRefine((value, context) => {
  if (value.classifiedAtMs < value.evaluatedAtMs || value.stabilizedAtMs < value.classifiedAtMs
    || value.features.endAtMs !== value.evaluatedAtMs
    || (value.stationaryFeatures !== undefined && value.stationaryFeatures.endAtMs !== value.evaluatedAtMs)
    || (value.candidateSinceMs !== null && value.candidateSinceMs > value.evaluatedAtMs)) {
    context.addIssue({ code: 'custom', message: '推定処理の時刻が不整合です。' })
  }
}) satisfies z.ZodType<MotionEstimate>

export function hasValidEstimateTimes(estimates: readonly MotionEstimate[], startAtMs: number, endAtMs?: number): boolean {
  let previous = startAtMs
  return estimates.every((estimate) => {
    const valid = estimate.evaluatedAtMs >= previous && (endAtMs === undefined || estimate.stabilizedAtMs <= endAtMs)
    previous = estimate.evaluatedAtMs
    return valid
  })
}
