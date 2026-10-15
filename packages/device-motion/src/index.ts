import type { Unsubscribe } from '@physical-adaptive/core'

export { summarizeMotionWindow } from './features'
export type { MagnitudeStatistics, MotionWindowSummary } from './features'
export { MotionEstimator, StateStabilizer, classifyMotion, validateEstimationConfig } from './estimation'
export type { EstimationConfig, MotionEstimate, ClassificationReason } from './estimation'

export interface Vector3 {
  readonly x: number | null
  readonly y: number | null
  readonly z: number | null
}

export interface RotationRate {
  readonly alpha: number | null
  readonly beta: number | null
  readonly gamma: number | null
}

/** Device-local receipt time; no clock synchronization or activity inference. */
export interface MotionSample {
  readonly receivedAtMs: number
  readonly eventTimestampMs: number | null
  /** Raw event.interval, without assuming the browser actually reports milliseconds. */
  readonly reportedIntervalRaw: number | null
  /** Difference between consecutive receipt timestamps in this subscription. */
  readonly receivedIntervalMs: number | null
  readonly acceleration: Vector3 | null
  readonly accelerationIncludingGravity: Vector3 | null
  readonly rotationRate: RotationRate | null
}

export type MotionPermission = 'prompt' | 'granted' | 'denied'

export interface MotionEventData {
  readonly timeStamp: number
  readonly interval: number
  readonly acceleration: Vector3 | null
  readonly accelerationIncludingGravity: Vector3 | null
  readonly rotationRate: RotationRate | null
}

/** Browser boundary is injected so permission and cleanup can be tested without a sensor. */
export interface MotionEnvironment {
  readonly secure: boolean
  readonly supported: boolean
  requestPermission?: () => Promise<'granted' | 'denied'>
  now: () => number
  listen: (listener: (event: MotionEventData) => void) => Unsubscribe
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function vector(value: Vector3 | null): Vector3 | null {
  return value === null ? null : { x: finite(value.x), y: finite(value.y), z: finite(value.z) }
}

export function snapshotMotionEvent(event: MotionEventData, receivedAtMs: number, previousReceivedAtMs: number | null = null): MotionSample {
  return {
    receivedAtMs,
    eventTimestampMs: finite(event.timeStamp),
    reportedIntervalRaw: finite(event.interval),
    receivedIntervalMs: previousReceivedAtMs === null ? null : finite(receivedAtMs - previousReceivedAtMs),
    acceleration: vector(event.acceleration),
    accelerationIncludingGravity: vector(event.accelerationIncludingGravity),
    rotationRate: event.rotationRate === null ? null : {
      alpha: finite(event.rotationRate.alpha),
      beta: finite(event.rotationRate.beta),
      gamma: finite(event.rotationRate.gamma),
    },
  }
}

export class DeviceMotionSource {
  private permission: MotionPermission = 'prompt'
  private stopListening: Unsubscribe | null = null

  private readonly environment: MotionEnvironment
  constructor(environment: MotionEnvironment) { this.environment = environment }

  getPermission(): MotionPermission { return this.permission }

  /** Call directly from a button handler, before awaiting any other operation. */
  async requestPermission(): Promise<MotionPermission> {
    if (!this.environment.secure) throw new Error('HTTPSで開いてください。')
    if (!this.environment.supported) throw new Error('このブラウザはDeviceMotionに対応していません。')
    this.permission = this.environment.requestPermission
      ? await this.environment.requestPermission()
      : 'granted'
    return this.permission
  }

  start(listener: (sample: MotionSample) => void): Unsubscribe {
    if (this.permission !== 'granted') throw new Error('先にセンサーの利用を許可してください。')
    if (this.stopListening) throw new Error('センサーは既に取得中です。')
    let previousReceivedAtMs: number | null = null
    const unsubscribe = this.environment.listen((event) => {
      const sample = snapshotMotionEvent(event, this.environment.now(), previousReceivedAtMs)
      previousReceivedAtMs = sample.receivedAtMs
      listener(sample)
    })
    let active = true
    const stop = () => {
      if (!active) return
      active = false
      unsubscribe()
      if (this.stopListening === stop) this.stopListening = null
    }
    this.stopListening = stop
    return stop
  }

  stop(): void { this.stopListening?.() }
}

/** No browser globals are accessed when this module is imported. */
export function createBrowserMotionSource(): DeviceMotionSource {
  type PermissionConstructor = typeof DeviceMotionEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>
  }
  const constructor = window.DeviceMotionEvent as PermissionConstructor | undefined
  return new DeviceMotionSource({
    secure: window.isSecureContext,
    supported: typeof constructor === 'function',
    requestPermission: constructor?.requestPermission
      ? () => constructor.requestPermission!()
      : undefined,
    now: () => performance.now(),
    listen: (listener) => {
      window.addEventListener('devicemotion', listener)
      return () => window.removeEventListener('devicemotion', listener)
    },
  })
}
