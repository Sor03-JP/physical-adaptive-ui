import { describe, expect, it } from 'vitest'
import { MotionEstimator, StateStabilizer, classifyMotion, summarizeMotionWindow } from './index'
import type { EstimationConfig, MotionSample } from './index'

const config: EstimationConfig = {
  windowMs: 1000, updateIntervalMs: 200, stationaryThreshold: 0.5, runningThreshold: 3.4,
  stableDurationMs: 400, minimumValidSamples: 40, maximumValidGapMs: 100, maximumUpdateGapMs: 600,
}
const sample = (time: number, magnitude: number): MotionSample => ({
  receivedAtMs: time, eventTimestampMs: time, reportedIntervalRaw: 0.0167, receivedIntervalMs: null,
  acceleration: { x: magnitude, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 10 }, rotationRate: null,
})
const samples = (end: number, magnitude: number) => Array.from({ length: 50 }, (_, i) => sample(end - 980 + i * 20, magnitude))

describe('RMS classifier', () => {
  it.each([[0.49, 'stationary'], [0.5, 'walking'], [3.39, 'walking'], [3.4, 'running']])(
    'classifies boundary RMS %s as %s', (rms, state) => {
      const features = summarizeMotionWindow(samples(1000, Number(rms)), 1000, 1000)
      // Test exact classifier boundaries separately from floating-point RMS accumulation.
      expect(classifyMotion({ ...features, acceleration: { ...features.acceleration!, rootMeanSquare: Number(rms) } },
        1000, 20, config)).toEqual({ state, reason: 'rms-threshold' })
    },
  )

  it('distinguishes warmup, missing acceleration, and receipt gaps from stationary', () => {
    const full = summarizeMotionWindow(samples(1000, 0), 1000, 1000)
    expect(classifyMotion(full, 999, 20, config).reason).toBe('warming-up')
    expect(classifyMotion(full, 1000, 101, config)).toEqual({ state: 'unknown', reason: 'data-gap' })
    const missing = summarizeMotionWindow(samples(1000, 0).map((s) => ({ ...s, acceleration: null })), 1000, 1000)
    expect(classifyMotion(missing, 1000, 1000, config)).toEqual({ state: 'unknown', reason: 'insufficient-data' })
  })
})

describe('state stabilization', () => {
  it('requires the candidate to persist and rejects a short excursion', () => {
    const stable = new StateStabilizer(400)
    expect(stable.update('stationary', 1000).stabilizedState).toBe('unknown')
    expect(stable.update('stationary', 1400)).toMatchObject({ stabilizedState: 'stationary', stabilizationReason: 'accepted' })
    expect(stable.update('running', 1600).stabilizedState).toBe('stationary')
    expect(stable.update('stationary', 1800).stabilizedState).toBe('stationary')
    stable.update('walking', 2000)
    expect(stable.update('walking', 2400).stabilizedState).toBe('walking')
  })

  it('invalidates immediately on unknown and starts recovery from a fresh candidate', () => {
    const stable = new StateStabilizer(400)
    stable.update('running', 0); stable.update('running', 400)
    expect(stable.update('unknown', 600)).toMatchObject({ stabilizedState: 'unknown', candidateSinceMs: null })
    expect(stable.update('running', 800).stabilizedState).toBe('unknown')
    expect(stable.update('running', 1200).stabilizedState).toBe('running')
    expect(stable.update('running', 2200, true).stabilizedState).toBe('unknown')
  })
})

describe('device-local estimation pipeline', () => {
  it('returns to stationary earlier after a direct stop while keeping the full running window', () => {
    let now = 0
    const baseline = new MotionEstimator(config, 0, () => now)
    const quicker = new MotionEstimator({ ...config, stationaryWindowMs: 400 }, 0, () => now)
    let baselineStop: number | undefined
    let quickerStop: number | undefined
    let shortDecision = false
    for (now = 0; now <= 5000; now += 20) {
      const input = sample(now, now < 3000 ? 6 : 0.03)
      baseline.append(input); quicker.append(input)
      const oldResult = baseline.evaluate(now)
      const result = quicker.evaluate(now)
      if (now < 3000) {
        expect(result?.classifiedState).toBe(oldResult?.classifiedState)
        expect(result?.stabilizedState).toBe(oldResult?.stabilizedState)
      }
      if (result?.classificationReason === 'short-window-stationary') {
        shortDecision = true
        expect(result.features.acceleration!.rootMeanSquare).toBeGreaterThan(config.stationaryThreshold)
        expect(result.stationaryFeatures!.acceleration!.rootMeanSquare).toBeLessThan(config.stationaryThreshold)
      }
      if (now >= 3000 && oldResult?.stabilizedState === 'stationary') baselineStop ??= now
      if (now >= 3000 && result?.stabilizedState === 'stationary') quickerStop ??= now
    }
    expect(shortDecision).toBe(true)
    expect(quickerStop).toBe(3800)
    expect(baselineStop).toBe(4400)
  })

  it('does not treat a brief quiet part of moving input as a stable stop', () => {
    let now = 0
    const estimator = new MotionEstimator({ ...config, stationaryWindowMs: 400 }, 0, () => now)
    for (now = 0; now <= 4000; now += 20) {
      estimator.append(sample(now, now >= 3000 && now < 3200 ? 0.03 : 2))
      const result = estimator.evaluate(now)
      if (now >= 1600 && result) expect(result.stabilizedState).toBe('walking')
    }
  })

  it('never converts missing recent acceleration or sensor silence into a quick stationary decision', () => {
    for (const silent of [true, false]) {
      let now = 1000
      const estimator = new MotionEstimator({ ...config, stationaryWindowMs: 400 }, 0, () => now)
      samples(1000, 6).forEach((s) => estimator.append(s))
      estimator.evaluate(now)
      now = 1400
      if (!silent) {
        for (let t = 1020; t <= now; t += 20) estimator.append({ ...sample(t, 0), acceleration: null })
      }
      const result = estimator.evaluate(now)
      expect(result?.classifiedState).toBe('unknown')
      expect(result?.stabilizedState).toBe('unknown')
      expect(result?.classificationReason).not.toBe('short-window-stationary')
    }
    expect(() => new MotionEstimator({ ...config, stationaryWindowMs: 1001 }, 0, () => 0)).toThrow()
    expect(() => new MotionEstimator({ ...config, stationaryWindowMs: 0 }, 0, () => 0)).toThrow()
  })

  it('tracks a full stationary-walking-running-walking-stationary sequence without mixing stage outputs', () => {
    let now = 0
    const estimator = new MotionEstimator(config, 0, () => now)
    const states = new Map<number, string>()
    for (now = 0; now <= 10000; now += 20) {
      const magnitude = now < 2000 || now >= 8000 ? 0.03 : now < 4000 || now >= 6000 ? 1.5 : 6
      estimator.append(sample(now, magnitude))
      const result = estimator.evaluate(now)
      if (result) states.set(now, result.stabilizedState)
    }
    expect([1600, 3600, 5600, 7600, 9600].map((time) => states.get(time)))
      .toEqual(['stationary', 'walking', 'running', 'walking', 'stationary'])
    expect(states.get(0)).toBe('unknown')
  })
  it('keeps classification, stabilization, and their actual processing timestamps separate', () => {
    let clock = 1000
    const estimator = new MotionEstimator(config, 0, () => ++clock)
    samples(1000, 1).forEach((s) => estimator.append(s))
    expect(estimator.evaluate(1000)).toMatchObject({ evaluatedAtMs: 1000, classifiedAtMs: 1001, stabilizedAtMs: 1002,
      classifiedState: 'walking', stabilizedState: 'unknown', stabilizationReason: 'pending' })
    expect(estimator.evaluate(1100)).toBeNull()
    for (let end = 1200; end <= 1400; end += 200) {
      for (let t = end - 180; t <= end; t += 20) estimator.append(sample(t, 1))
      clock = end
      const result = estimator.evaluate(end)
      if (end === 1400) expect(result?.stabilizedState).toBe('walking')
    }
  })

  it('detects sensor silence on timer evaluations without needing another sensor event', () => {
    let now = 1000
    const estimator = new MotionEstimator(config, 0, () => now)
    samples(1000, 1).forEach((s) => estimator.append(s))
    estimator.evaluate(now)
    now = 1200
    expect(estimator.evaluate(now)).toMatchObject({ classifiedState: 'unknown', stabilizedState: 'unknown', classificationReason: 'data-gap' })
    now = 2000
    expect(estimator.evaluate(now)).toMatchObject({ classifiedState: 'unknown', classificationReason: 'insufficient-data' })
  })

  it('checks gaps between valid acceleration values, not just motion-event delivery', () => {
    const estimator = new MotionEstimator(config, 0, () => 1000)
    samples(1000, 1).forEach((s) => estimator.append({ ...s, acceleration: s.receivedAtMs > 800 ? null : s.acceleration }))
    expect(estimator.evaluate(1000)).toMatchObject({ maximumValidGapMs: 200, classificationReason: 'data-gap' })
  })

  it('does not count a timer suspension as continuous supporting decisions', () => {
    let now = 1000
    const estimator = new MotionEstimator(config, 0, () => now)
    samples(1000, 5).forEach((s) => estimator.append(s))
    estimator.evaluate(now)
    samples(2000, 5).forEach((s) => estimator.append(s))
    now = 2000
    expect(estimator.evaluate(now)).toMatchObject({ classifiedState: 'running', stabilizedState: 'unknown', updateGap: true, candidateSinceMs: 2000 })
  })

  it('rejects invalid configuration and reversed timestamps, and isolates configuration from mutation', () => {
    expect(() => new MotionEstimator({ ...config, runningThreshold: 0.1 }, 0, () => 0)).toThrow()
    expect(() => new MotionEstimator({ ...config, minimumValidSamples: 1.5 }, 0, () => 0)).toThrow()
    expect(() => new MotionEstimator({ ...config, windowMs: NaN }, 0, () => 0)).toThrow()
    const mutable = { ...config }
    const estimator = new MotionEstimator(mutable, 10, () => 20)
    mutable.windowMs = 10
    expect(estimator.config.windowMs).toBe(1000)
    expect(() => estimator.append(sample(9, 0))).toThrow()
    estimator.append(sample(20, 0))
    expect(() => estimator.evaluate(19)).toThrow()
  })
})
