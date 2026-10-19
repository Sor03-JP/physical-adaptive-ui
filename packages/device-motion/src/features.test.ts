import { describe, expect, it } from 'vitest'
import { summarizeMotionWindow } from './index'

const sample = (receivedAtMs: number, x: number | null = 0) => ({
  receivedAtMs, acceleration: { x, y: 0, z: 0 },
  accelerationIncludingGravity: { x: 0, y: 0, z: 10 },
})

describe('motion window features', () => {
  it('computes statistics from vector magnitudes, with gravity channels kept separate', () => {
    const result = summarizeMotionWindow([
      { ...sample(10), acceleration: { x: 3, y: 4, z: 0 } }, sample(20, 1),
    ], 20, 20)
    expect(result.acceleration).toEqual({ validCount: 2, mean: 3, standardDeviation: 2,
      rootMeanSquare: Math.sqrt(13), range: 4 })
    expect(result.accelerationIncludingGravity).toEqual({ validCount: 2, mean: 10,
      standardDeviation: 0, rootMeanSquare: 10, range: 0 })
  })

  it('selects a time window rather than a fixed number of events, excluding the left boundary', () => {
    const samples = [sample(0, 99), sample(10, 99), sample(11, 2), sample(20, 4), sample(21, 99)]
    const result = summarizeMotionWindow(samples, 20, 10)
    expect(result).toMatchObject({ startAtMs: 10, endAtMs: 20, sampleCount: 2,
      firstSampleAtMs: 11, lastSampleAtMs: 20, maximumGapMs: 9 })
    expect(result.acceleration?.mean).toBe(3)
    expect(samples[0].acceleration.x).toBe(99)
  })

  it('keeps missing vectors distinct from true zero and never fills them with the other channel', () => {
    const result = summarizeMotionWindow([
      sample(10, null), sample(20, 0), sample(30, NaN),
      { ...sample(40), acceleration: null, accelerationIncludingGravity: null },
    ], 40, 40)
    expect(result.sampleCount).toBe(4)
    expect(result.acceleration).toEqual({ validCount: 1, mean: 0, standardDeviation: 0,
      rootMeanSquare: 0, range: 0 })
    expect(result.accelerationIncludingGravity?.validCount).toBe(3)
    expect(summarizeMotionWindow([sample(10, null)], 10, 10).acceleration).toBeNull()
  })

  it('reports empty or stale windows as no data and retains gaps at both edges', () => {
    expect(summarizeMotionWindow([], 100, 50)).toEqual({ startAtMs: 50, endAtMs: 100,
      sampleCount: 0, firstSampleAtMs: null, lastSampleAtMs: null, maximumGapMs: 50,
      acceleration: null, accelerationIncludingGravity: null })
    expect(summarizeMotionWindow([sample(10)], 100, 50).sampleCount).toBe(0)
    expect(summarizeMotionWindow([sample(60), sample(65)], 100, 50).maximumGapMs).toBe(35)
  })

  it('does not use the API-reported interval as the window clock', () => {
    const samples = [10, 20].map((time) => ({ ...sample(time), reportedIntervalRaw: 0.016666667 }))
    expect(summarizeMotionWindow(samples, 20, 15).sampleCount).toBe(2)
  })

  it('rejects invalid configuration and reversed or invalid timestamps', () => {
    for (const width of [0, -1, Infinity, NaN]) {
      expect(() => summarizeMotionWindow([], 20, width)).toThrow()
    }
    for (const end of [-1, Infinity, NaN]) {
      expect(() => summarizeMotionWindow([], end, 10)).toThrow()
    }
    for (const samples of [[sample(20), sample(10)], [sample(-1)], [sample(NaN)]]) {
      expect(() => summarizeMotionWindow(samples, 20, 10)).toThrow()
    }
  })
})
