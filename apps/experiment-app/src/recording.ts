import { MotionEstimator } from '@physical-adaptive/device-motion'
import type { MotionSample, MotionEstimate, EstimationConfig } from '@physical-adaptive/device-motion'
import { BATCH_SIZE, MAX_SAMPLES, hasCompleteAcceleration } from './recording-schema'
import type { Recording, RecordingMetadata, Completion, StopReason } from './recording-schema'

export * from './recording-schema'

export class MeasurementRecorder {
  private readonly samples: MotionSample[] = []
  private readonly estimates: MotionEstimate[] = []
  private readonly estimator: MotionEstimator | null
  private endedAtMs: number | null = null
  private stopReason: StopReason = 'manual'
  private completeAccelerationCount = 0

  constructor(readonly metadata: RecordingMetadata, config?: EstimationConfig, clock: () => number = () => performance.now()) {
    this.estimator = config ? new MotionEstimator(config, metadata.startedAtMs, clock) : null
  }

  get estimationConfig(): EstimationConfig | null { return this.estimator?.config ?? null }
  get estimateCount(): number { return this.estimates.length }
  get latestEstimate(): MotionEstimate | null { return this.estimates.at(-1) ?? null }

  evaluate(now: number): void {
    if (!this.active || !this.estimator) return
    const estimate = this.estimator.evaluate(now)
    if (estimate) this.estimates.push(estimate)
    if (this.estimates.length === MAX_SAMPLES) this.stop(estimate!.stabilizedAtMs, 'capacity')
  }

  estimateBatch(startIndex: number, size = BATCH_SIZE): MotionEstimate[] {
    return this.estimates.slice(startIndex, startIndex + size)
  }

  get active(): boolean { return this.endedAtMs === null }

  get completion(): Completion | null {
    return this.endedAtMs === null ? null : { endedAtMs: this.endedAtMs, stopReason: this.stopReason }
  }

  batch(startIndex: number, size = BATCH_SIZE): MotionSample[] {
    return this.samples.slice(startIndex, startIndex + size)
  }

  append(sample: MotionSample): void {
    if (!this.active) return
    // A recording starts a new interval sequence, independently of preview events.
    const previous = this.samples.at(-1)
    this.samples.push({ ...sample, receivedIntervalMs: previous === undefined
      ? null : sample.receivedAtMs - previous.receivedAtMs })
    this.estimator?.append(sample)
    if (hasCompleteAcceleration(sample)) this.completeAccelerationCount++
    if (this.samples.length === MAX_SAMPLES) this.stop(sample.receivedAtMs, 'capacity')
  }

  stop(now: number, reason: StopReason): void {
    if (!this.active) return
    this.endedAtMs = now
    this.stopReason = reason
  }

  view(now: number) {
    const latest = this.samples.at(-1) ?? null
    return {
      count: this.samples.length, completeAccelerationCount: this.completeAccelerationCount,
      latest, elapsedMs: (this.endedAtMs ?? now) - this.metadata.startedAtMs,
      sinceLastSampleMs: latest === null ? null : Math.max(0, now - latest.receivedAtMs),
      stopReason: this.active ? null : this.stopReason,
    }
  }

  recording(): Recording {
    if (this.endedAtMs === null) throw new Error('停止してからJSONを出力してください。')
    return {
      format: 'physical-adaptive-motion-measurement', version: 2,
      ...this.metadata, clock: 'device-local-performance', endedAtMs: this.endedAtMs,
      stopReason: this.stopReason, samples: this.samples.slice(),
    }
  }
}
