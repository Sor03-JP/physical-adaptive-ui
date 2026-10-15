import type { PhysicalState } from '@physical-adaptive/core'
import type { MotionSample } from './index'
import { summarizeMotionWindow } from './features'
import type { MotionWindowSummary } from './features'

export interface EstimationConfig {
  readonly windowMs: number
  readonly updateIntervalMs: number
  readonly stationaryThreshold: number
  readonly runningThreshold: number
  readonly stableDurationMs: number
  readonly minimumValidSamples: number
  readonly maximumValidGapMs: number
  readonly maximumUpdateGapMs: number
  /** Optional shorter window for returning to stationary; absent in older recordings. */
  readonly stationaryWindowMs?: number
}

export type ClassificationReason = 'warming-up' | 'insufficient-data' | 'data-gap' | 'rms-threshold' | 'short-window-stationary'
export interface MotionEstimate {
  readonly evaluatedAtMs: number
  readonly classifiedAtMs: number
  readonly stabilizedAtMs: number
  readonly classifiedState: PhysicalState
  readonly stabilizedState: PhysicalState
  readonly classificationReason: ClassificationReason
  readonly stabilizationReason: 'unknown' | 'pending' | 'accepted' | 'unchanged'
  readonly candidateState: PhysicalState
  readonly candidateSinceMs: number | null
  readonly updateGap: boolean
  readonly maximumValidGapMs: number
  readonly features: MotionWindowSummary
  readonly stationaryFeatures?: MotionWindowSummary
  readonly stationaryMaximumValidGapMs?: number
}

export function validateEstimationConfig(config: EstimationConfig): void {
  if (Object.values(config).some((value) => !Number.isFinite(value) || value <= 0)
    || !Number.isInteger(config.minimumValidSamples)
    || config.stationaryThreshold >= config.runningThreshold
    || config.maximumUpdateGapMs < config.updateIntervalMs
    || (config.stationaryWindowMs !== undefined && config.stationaryWindowMs > config.windowMs)) {
    throw new Error('推定設定の値・閾値の順序が不正です。')
  }
}

function maximumValidGap(samples: readonly MotionSample[], startAtMs: number, endAtMs: number): number {
  let previous = startAtMs
  let maximum = 0
  for (const sample of samples) {
    if (sample.receivedAtMs <= startAtMs || sample.receivedAtMs > endAtMs) continue
    const value = sample.acceleration
    if (!value || value.x === null || value.y === null || value.z === null
      || !Number.isFinite(Math.hypot(value.x, value.y, value.z))) continue
    maximum = Math.max(maximum, sample.receivedAtMs - previous)
    previous = sample.receivedAtMs
  }
  return Math.max(maximum, endAtMs - previous)
}

export function classifyMotion(features: MotionWindowSummary, elapsedMs: number, maximumValidGapMs: number,
  config: EstimationConfig): { state: PhysicalState; reason: ClassificationReason } {
  if (elapsedMs < config.windowMs) return { state: 'unknown', reason: 'warming-up' }
  const stats = features.acceleration
  if (!stats || stats.validCount < config.minimumValidSamples) return { state: 'unknown', reason: 'insufficient-data' }
  if (maximumValidGapMs > config.maximumValidGapMs) return { state: 'unknown', reason: 'data-gap' }
  const rms = stats.rootMeanSquare
  return { state: rms < config.stationaryThreshold ? 'stationary' : rms < config.runningThreshold ? 'walking' : 'running',
    reason: 'rms-threshold' }
}

/** Unknown immediately invalidates the stable state; recovery requires a new continuous candidate. */
export class StateStabilizer {
  private state: PhysicalState = 'unknown'
  private candidate: PhysicalState = 'unknown'
  private since: number | null = null

  constructor(private readonly durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('安定化時間は正の有限値が必要です。')
  }

  update(input: PhysicalState, now: number, reset = false) {
    if (reset || input === 'unknown') {
      this.state = 'unknown'; this.candidate = 'unknown'; this.since = null
    }
    let reason: MotionEstimate['stabilizationReason'] = 'unknown'
    if (input !== 'unknown') {
      if (input !== this.candidate) { this.candidate = input; this.since = now }
      if (input === this.state) reason = 'unchanged'
      else if (now - this.since! >= this.durationMs) { this.state = input; reason = 'accepted' }
      else reason = 'pending'
    }
    return { stabilizedState: this.state, candidateState: this.candidate,
      candidateSinceMs: this.since, stabilizationReason: reason }
  }
}

/** Device-local window and decision times. The clock is injected; no browser or React dependency. */
export class MotionEstimator {
  private samples: MotionSample[] = []
  private lastSampleAtMs: number
  private lastEvaluationAtMs: number | null = null
  private readonly stabilizer: StateStabilizer
  readonly config: EstimationConfig

  constructor(config: EstimationConfig, private readonly startedAtMs: number, private readonly clock: () => number) {
    validateEstimationConfig(config)
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) throw new Error('開始時刻が不正です。')
    this.config = Object.freeze({ ...config })
    this.lastSampleAtMs = startedAtMs
    this.stabilizer = new StateStabilizer(config.stableDurationMs)
  }

  append(sample: MotionSample): void {
    if (!Number.isFinite(sample.receivedAtMs) || sample.receivedAtMs < this.lastSampleAtMs) {
      throw new Error('サンプル時刻が不正です。')
    }
    this.lastSampleAtMs = sample.receivedAtMs
    this.samples.push(sample)
    this.trim(sample.receivedAtMs)
  }

  private trim(now: number) {
    this.samples = this.samples.filter((sample) => sample.receivedAtMs > now - this.config.windowMs)
  }

  evaluate(now: number): MotionEstimate | null {
    if (!Number.isFinite(now) || now < Math.max(this.startedAtMs, this.lastEvaluationAtMs ?? 0, this.lastSampleAtMs)) {
      throw new Error('判定時刻が不正です。')
    }
    if (this.lastEvaluationAtMs !== null && now - this.lastEvaluationAtMs < this.config.updateIntervalMs) return null
    const updateGap = this.lastEvaluationAtMs !== null && now - this.lastEvaluationAtMs > this.config.maximumUpdateGapMs
    this.lastEvaluationAtMs = now
    this.trim(now)
    const features = summarizeMotionWindow(this.samples, now, this.config.windowMs)
    const maximumValidGapMs = maximumValidGap(this.samples, features.startAtMs, now)
    let classification = classifyMotion(features, now - this.startedAtMs, maximumValidGapMs, this.config)
    const stationaryWindowMs = this.config.stationaryWindowMs
    let stationary: Pick<MotionEstimate, 'stationaryFeatures' | 'stationaryMaximumValidGapMs'> = {}
    if (stationaryWindowMs !== undefined) {
      const shortFeatures = summarizeMotionWindow(this.samples, now, stationaryWindowMs)
      const shortGap = maximumValidGap(this.samples, shortFeatures.startAtMs, now)
      stationary = { stationaryFeatures: shortFeatures, stationaryMaximumValidGapMs: shortGap }
      // Require a healthy full window first; missing data must never become a quick stop.
      const minimumSamples = Math.ceil(this.config.minimumValidSamples * stationaryWindowMs / this.config.windowMs)
      if ((classification.state === 'walking' || classification.state === 'running')
        && shortFeatures.acceleration && shortFeatures.acceleration.validCount >= minimumSamples
        && shortGap <= this.config.maximumValidGapMs
        && shortFeatures.acceleration.rootMeanSquare < this.config.stationaryThreshold) {
        classification = { state: 'stationary', reason: 'short-window-stationary' }
      }
    }
    const classifiedAtMs = this.clock()
    const stable = this.stabilizer.update(classification.state, now, updateGap)
    return { evaluatedAtMs: now, classifiedAtMs, stabilizedAtMs: this.clock(),
      classifiedState: classification.state, classificationReason: classification.reason,
      ...stable, ...stationary, updateGap, maximumValidGapMs, features }
  }
}
