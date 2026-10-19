import type { PhysicalState } from './index'

export type DisplayState = Exclude<PhysicalState, 'unknown'>
export interface AdaptationConfig {
  readonly unknownHoldMs: number
  readonly maximumEstimateAgeMs: number
}
export interface StableContext { readonly state: PhysicalState; readonly atMs: number }
export interface AdaptationDecision {
  readonly state: DisplayState
  readonly reason: 'initial' | 'estimated' | 'unknown-hold' | 'unknown-fallback'
  readonly stale: boolean
}

/** UI policy only: no sensor, React, DOM, storage, or CSS dependency. */
export class AdaptationPolicy {
  private lastValid: DisplayState | null = null
  private lastValidAtMs: number | null = null
  private unknownSinceMs: number | null = null
  private previousAtMs = -1
  private readonly config: AdaptationConfig

  constructor(config: AdaptationConfig) {
    if (!Number.isFinite(config.unknownHoldMs) || config.unknownHoldMs < 0
      || !Number.isFinite(config.maximumEstimateAgeMs) || config.maximumEstimateAgeMs <= 0) {
      throw new Error('表示維持・推定有効時間の設定が不正です。')
    }
    this.config = { ...config }
  }

  resolve(input: StableContext | null, now: number): AdaptationDecision {
    if (!Number.isFinite(now) || now < 0 || now < this.previousAtMs
      || (input && (!Number.isFinite(input.atMs) || input.atMs < 0 || input.atMs > now))) {
      throw new Error('適応判定の時刻が不正です。')
    }
    this.previousAtMs = now
    const stale = input !== null && now - input.atMs > this.config.maximumEstimateAgeMs
    if (input && !stale && input.state !== 'unknown') {
      this.lastValid = input.state; this.lastValidAtMs = input.atMs; this.unknownSinceMs = null
      return { state: input.state, reason: 'estimated', stale: false }
    }
    const observedUnknownAtMs = input ? Math.min(now, input.state === 'unknown' ? input.atMs : input.atMs + this.config.maximumEstimateAgeMs) : now
    // A fresh 'unknown' after a long processing gap must not restart a hold on an already expired display.
    this.unknownSinceMs ??= Math.min(observedUnknownAtMs,
      this.lastValidAtMs === null ? now : this.lastValidAtMs + this.config.maximumEstimateAgeMs)
    if (this.lastValid === null) return { state: 'stationary', reason: 'initial', stale }
    if (now - this.unknownSinceMs < this.config.unknownHoldMs) return { state: this.lastValid, reason: 'unknown-hold', stale }
    return { state: 'stationary', reason: 'unknown-fallback', stale }
  }
}
