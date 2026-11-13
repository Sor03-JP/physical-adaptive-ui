import { describe, expect, it } from 'vitest'
import type { MotionSample } from '@physical-adaptive/device-motion'
import { MAX_SAMPLES, MeasurementRecorder, readRecording, writeRecording } from './recording'

const metadata = {
  sessionId: 'test-session', startedAt: '2026-10-15T00:00:00.000Z',
  timeOriginMs: 1000, startedAtMs: 10, userAgent: 'test',
}
const sample: MotionSample = {
  receivedAtMs: 20, eventTimestampMs: 19, reportedIntervalRaw: 0.01666666753590107, receivedIntervalMs: null,
  acceleration: { x: 0, y: null, z: 1 },
  accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, rotationRate: null,
}

function recording() {
  const recorder = new MeasurementRecorder(metadata)
  recorder.append(sample)
  recorder.stop(30, 'manual')
  return recorder.recording()
}

describe('measurement recording', () => {
  it('round trips every sample, missing value and clock metadata', () => {
    const original = recording()
    expect(readRecording(writeRecording(original))).toEqual(original)
    expect(readRecording(writeRecording(original)).samples[0].acceleration?.x).toBe(0)
    expect(readRecording(writeRecording(original)).samples[0].acceleration?.y).toBeNull()
  })

  it('does not export an active session or append after stopping', () => {
    const recorder = new MeasurementRecorder(metadata)
    expect(() => recorder.recording()).toThrow('停止')
    recorder.append(sample)
    recorder.stop(30, 'page-hidden')
    recorder.stop(40, 'manual')
    recorder.append({ ...sample, receivedAtMs: 35 })
    expect(recorder.recording()).toMatchObject({ endedAtMs: 30, stopReason: 'page-hidden' })
    expect(recorder.recording().samples).toHaveLength(1)
  })

  it('retains the whole bounded recording instead of silently discarding old data', () => {
    const recorder = new MeasurementRecorder(metadata)
    for (let i = 0; i <= MAX_SAMPLES; i++) recorder.append({ ...sample, receivedAtMs: 20 + i })
    expect(recorder.active).toBe(false)
    const data = recorder.recording()
    expect(data.samples).toHaveLength(MAX_SAMPLES)
    expect(data.samples[0].receivedAtMs).toBe(20)
    expect(data.stopReason).toBe('capacity')
    expect(data.endedAtMs).toBe(20 + MAX_SAMPLES - 1)
  })

  it('counts complete acceleration separately from receiving all-null events', () => {
    const recorder = new MeasurementRecorder(metadata)
    recorder.append(sample)
    recorder.append({ ...sample, receivedAtMs: 21,
      acceleration: null, accelerationIncludingGravity: { x: null, y: null, z: null } })
    expect(recorder.view(25)).toMatchObject({ count: 2, completeAccelerationCount: 1,
      sinceLastSampleMs: 4, elapsedMs: 15 })
  })

  it('rejects another format or version, missing columns and nonfinite values', () => {
    const original = recording()
    expect(() => readRecording('{')).toThrow()
    expect(() => readRecording(JSON.stringify({ ...original, version: 3 }))).toThrow()
    expect(() => readRecording(JSON.stringify({ ...original, format: 'main-experiment' }))).toThrow()
    const { userAgent: _agent, ...missingColumn } = original
    expect(() => readRecording(JSON.stringify(missingColumn))).toThrow()
    expect(() => writeRecording({ ...original, endedAtMs: Number.POSITIVE_INFINITY })).toThrow()
  })

  it('rejects negative, reversed and out-of-range receipt times', () => {
    const original = recording()
    for (const receivedAtMs of [-1, 5, 31]) {
      expect(() => readRecording(JSON.stringify({ ...original, samples: [{ ...sample, receivedAtMs }] }))).toThrow()
    }
    expect(() => writeRecording({ ...original, samples: [sample, { ...sample, receivedAtMs: 19 }] })).toThrow()
    expect(() => writeRecording({ ...original, endedAtMs: 5, samples: [] })).toThrow()
  })

  it('keeps imported data separate from an ongoing recording', () => {
    const recorder = new MeasurementRecorder(metadata)
    recorder.append(sample)
    const imported = readRecording(writeRecording(recording()))
    imported.samples[0].acceleration!.x = 99
    expect(recorder.view(25).latest?.acceleration?.x).toBe(0)
    expect(recorder.active).toBe(true)
  })
})

it('keeps stopped phone samples available for retransmission until explicitly cleared', () => {
  const recorder = new MeasurementRecorder(metadata)
  recorder.append(sample)
  recorder.append({ ...sample, receivedAtMs: 21 })
  recorder.stop(30, 'manual')
  expect(recorder.batch(0, 1)).toEqual([sample])
  expect(recorder.batch(1, 1)).toEqual([{ ...sample, receivedAtMs: 21, receivedIntervalMs: 1 }])
  expect(recorder.batch(0, 1)).toEqual([sample])
  expect(recorder.completion).toEqual({ endedAtMs: 30, stopReason: 'manual' })
})

it('resets the first recorded interval even if the sensor was already previewing', () => {
  const recorder = new MeasurementRecorder(metadata)
  recorder.append({ ...sample, receivedIntervalMs: 17 })
  recorder.append({ ...sample, receivedAtMs: 37, receivedIntervalMs: 999 })
  recorder.stop(40, 'manual')
  expect(recorder.recording().samples.map((s) => s.receivedIntervalMs)).toEqual([null, 17])
})

it('reads legacy v1 recording values without conversion or rewriting the format', () => {
  const original = recording()
  const legacy = { ...original, version: 1, samples: original.samples.map(
    ({ reportedIntervalRaw, receivedIntervalMs: _delta, ...rest }) => ({ ...rest, intervalMs: reportedIntervalRaw }),
  ) }
  const text = JSON.stringify(legacy)
  const loaded = readRecording(text)
  expect(loaded).toEqual(legacy)
  expect(JSON.parse(writeRecording(loaded))).toEqual(legacy)
})

it('rejects a v2 recording whose declared interval contradicts the timestamps', () => {
  const original = recording()
  expect(() => readRecording(JSON.stringify({ ...original,
    samples: [{ ...original.samples[0], receivedIntervalMs: 17 }],
  }))).toThrow()
})
