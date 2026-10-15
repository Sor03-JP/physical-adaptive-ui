import type { MotionSample, Vector3 } from './index'

export interface MagnitudeStatistics {
  readonly validCount: number
  readonly mean: number
  /** Population standard deviation of the valid vector magnitudes. */
  readonly standardDeviation: number
  readonly rootMeanSquare: number
  readonly range: number
}

export interface MotionWindowSummary {
  readonly startAtMs: number
  readonly endAtMs: number
  readonly sampleCount: number
  readonly firstSampleAtMs: number | null
  readonly lastSampleAtMs: number | null
  /** Includes gaps from the requested window edges to the first/last receipt. */
  readonly maximumGapMs: number
  readonly acceleration: MagnitudeStatistics | null
  readonly accelerationIncludingGravity: MagnitudeStatistics | null
}

type FeatureSample = Pick<MotionSample, 'receivedAtMs' | 'acceleration' | 'accelerationIncludingGravity'>

function magnitude(vector: Vector3 | null): number | null {
  if (vector === null || vector.x === null || vector.y === null || vector.z === null) return null
  const value = Math.hypot(vector.x, vector.y, vector.z)
  return Number.isFinite(value) ? value : null
}

function statistics(values: readonly number[]): MagnitudeStatistics | null {
  if (values.length === 0) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const meanSquare = values.reduce((sum, value) => sum + value ** 2, 0) / values.length
  const minimum = values.reduce((min, value) => Math.min(min, value), Infinity)
  const maximum = values.reduce((max, value) => Math.max(max, value), -Infinity)
  return {
    validCount: values.length, mean, standardDeviation: Math.sqrt(variance),
    rootMeanSquare: Math.sqrt(meanSquare), range: maximum - minimum,
  }
}

/** Sample-weighted statistics over (endAtMs - windowMs, endAtMs]. No interpolation or activity inference. */
export function summarizeMotionWindow(samples: readonly FeatureSample[], endAtMs: number, windowMs: number): MotionWindowSummary {
  if (!Number.isFinite(endAtMs) || endAtMs < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('終了時刻は非負、時間窓は正の有限値をミリ秒で指定してください。')
  }
  const startAtMs = endAtMs - windowMs
  const acceleration: number[] = []
  const includingGravity: number[] = []
  let previousInput = -Infinity
  let previousReceipt = startAtMs
  let firstSampleAtMs: number | null = null
  let lastSampleAtMs: number | null = null
  let sampleCount = 0
  let maximumGapMs = 0
  for (const sample of samples) {
    const time = sample.receivedAtMs
    if (!Number.isFinite(time) || time < 0 || time < previousInput) {
      throw new Error('サンプルの受信時刻は非負の有限値・昇順である必要があります。')
    }
    previousInput = time
    if (time <= startAtMs || time > endAtMs) continue
    firstSampleAtMs ??= time
    lastSampleAtMs = time
    sampleCount++
    maximumGapMs = Math.max(maximumGapMs, time - previousReceipt)
    previousReceipt = time
    const value = magnitude(sample.acceleration)
    const gravityValue = magnitude(sample.accelerationIncludingGravity)
    if (value !== null) acceleration.push(value)
    if (gravityValue !== null) includingGravity.push(gravityValue)
  }
  return {
    startAtMs, endAtMs, sampleCount, firstSampleAtMs, lastSampleAtMs,
    maximumGapMs: Math.max(maximumGapMs, endAtMs - previousReceipt),
    acceleration: statistics(acceleration), accelerationIncludingGravity: statistics(includingGravity),
  }
}
