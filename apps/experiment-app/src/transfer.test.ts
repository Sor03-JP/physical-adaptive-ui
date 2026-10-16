import { describe, expect, it } from 'vitest'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import type { MotionSample } from '@physical-adaptive/device-motion'
import { MeasurementRecorder } from './recording'
import { estimationConfig } from './estimation'
import { messageSchema } from './protocol'

const metadata = { sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z',
  timeOriginMs: 1000, startedAtMs: 10, userAgent: 'phone' }
const sample: MotionSample = { receivedAtMs: 20, eventTimestampMs: 19, reportedIntervalRaw: 0.01666666753590107, receivedIntervalMs: null,
  acceleration: { x: 0, y: null, z: 1 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, rotationRate: null }
const completion = { endedAtMs: 30, stopReason: 'manual' as const }

describe('PC transfer collector', () => {
  it('summarizes a caller-selected window ending at the last phone receipt without changing the recording', () => {
    const collector = new TransferCollector(metadata, 5000)
    expect(collector.features(10)).toBeNull()
    collector.receive(0, [sample], 500)
    collector.receive(1, [{ ...sample, receivedAtMs: 25, receivedIntervalMs: 5,
      acceleration: { x: 3, y: 4, z: 0 } }], 900)
    collector.updateStatus(2, completion)
    const before = collector.export()
    expect(collector.features(5)).toMatchObject({ startAtMs: 20, endAtMs: 25, sampleCount: 1,
      acceleration: { validCount: 1, mean: 5, standardDeviation: 0 } })
    expect(collector.features(10)?.sampleCount).toBe(2)
    expect(collector.export()).toEqual(before)
  })
  it('preserves phone timestamps separately from PC receipt times and round trips the full recording', () => {
    const collector = new TransferCollector(metadata, 5000)
    collector.updateStatus(1, completion)
    collector.receive(0, [sample], 500)
    const data = collector.export()
    expect(data.complete).toBe(true)
    expect(data.samples[0].receivedAtMs).toBe(20)
    expect(data.receipts).toEqual([{ startIndex: 0, count: 1, controllerReceivedAtMs: 500 }])
    expect(data.metadata.timeOriginMs).toBe(1000)
    expect(readTransfer(writeTransfer(data))).toEqual(data)
  })
  it('does not complete until every sample is received, even when stopped first', () => {
    const collector = new TransferCollector(metadata, 5000)
    collector.updateStatus(2, completion)
    collector.receive(0, [sample], 50)
    expect(collector.complete).toBe(false)
    expect(collector.export()).toMatchObject({ complete: false, expectedCount: 2 })
    collector.receive(1, [{ ...sample, receivedAtMs: 25, receivedIntervalMs: 5 }], 60)
    expect(collector.complete).toBe(true)
  })
  it('ignores duplicate and out-of-order batches so retrying the missing index loses no data', () => {
    const collector = new TransferCollector(metadata, 5000)
    expect(collector.receive(1, [sample], 50)).toBe(false)
    expect(collector.receive(0, [sample], 51)).toBe(true)
    expect(collector.receive(0, [sample], 52)).toBe(false)
    expect(collector.receive(1, [{ ...sample, receivedAtMs: 25, receivedIntervalMs: 5 }], 53)).toBe(true)
    expect(collector.count).toBe(2)
    expect(collector.export().receipts).toHaveLength(2)
  })
  it('retains partial data without inventing a phone stop time after disconnection', () => {
    const collector = new TransferCollector(metadata, 5000)
    collector.updateStatus(3, null)
    collector.receive(0, [sample], 60)
    expect(readTransfer(writeTransfer(collector.export()))).toMatchObject({
      complete: false, expectedCount: 3, completion: null, samples: [sample],
    })
  })
  it('rejects corrupt counts, receipt indexes and non-monotonic sample timestamps', () => {
    const collector = new TransferCollector(metadata, 5000)
    collector.receive(0, [sample], 50)
    expect(collector.receive(1, [{ ...sample, receivedAtMs: 19 }], 60)).toBe(false)
    collector.updateStatus(1, completion)
    const data = collector.export()
    expect(() => readTransfer(JSON.stringify({ ...data, expectedCount: 2 }))).toThrow()
    expect(() => readTransfer(JSON.stringify({ ...data, receipts: [{ ...data.receipts[0], startIndex: 1 }] }))).toThrow()
    expect(() => readTransfer(JSON.stringify({ ...data, samples: [{ ...sample, receivedAtMs: 31 }] }))).toThrow()
  })
})

it('reads legacy v1 PC transfers with their original field names and raw values', () => {
  const collector = new TransferCollector(metadata, 5000)
  collector.receive(0, [sample], 50); collector.updateStatus(1, completion)
  const original = collector.export()
  const { observationProtocol: _observationProtocol, management: _management, recovery: _recovery, questionnaires: _questionnaires, research: _research, inference: _inference, tasks: _tasks, ...withoutInference } = original
  const legacy = { ...withoutInference, version: 1, samples: original.samples.map(
    ({ reportedIntervalRaw, receivedIntervalMs: _delta, ...rest }) => ({ ...rest, intervalMs: reportedIntervalRaw }),
  ) }
  const loaded = readTransfer(JSON.stringify(legacy))
  expect(loaded).toEqual(legacy)
  expect(JSON.parse(writeTransfer(loaded))).toEqual(legacy)
})

it('keeps receipt intervals correct across transfer batches and rejects inconsistent ones', () => {
  const collector = new TransferCollector(metadata, 5000)
  collector.receive(0, [sample], 50)
  expect(collector.receive(1, [{ ...sample, receivedAtMs: 25, receivedIntervalMs: 0.005 }], 60)).toBe(false)
  expect(collector.receive(1, [{ ...sample, receivedAtMs: 25, receivedIntervalMs: 5 }], 61)).toBe(true)
  collector.updateStatus(2, completion)
  expect(collector.export().samples.map((s) => s.receivedIntervalMs)).toEqual([null, 5])
})

it('waits for every estimate, retries missing batches, and exports device processing times with settings', () => {
  let now = 1010
  const recorder = new MeasurementRecorder(metadata, estimationConfig, () => now + 1)
  for (let t = 30; t <= 1010; t += 20) recorder.append({ ...sample, receivedAtMs: t, acceleration: { x: 1, y: 0, z: 0 } })
  recorder.evaluate(now)
  now = 1210
  recorder.evaluate(now)
  recorder.stop(1220, 'manual')
  const collector = new TransferCollector(metadata, 5000, recorder.estimationConfig)
  collector.updateStatus(50, recorder.completion, recorder.estimateCount)
  collector.receive(0, recorder.batch(0), 2000)
  expect(collector.complete).toBe(false)
  expect(collector.receiveEstimates(1, recorder.estimateBatch(1))).toBe(false)
  expect(collector.receiveEstimates(0, recorder.estimateBatch(0, 1))).toBe(true)
  expect(collector.receiveEstimates(0, recorder.estimateBatch(0, 1))).toBe(false)
  expect(collector.complete).toBe(false)
  expect(collector.receiveEstimates(1, recorder.estimateBatch(1))).toBe(true)
  expect(collector.complete).toBe(true)
  const data = readTransfer(writeTransfer(collector.export()))
  expect(data.version).toBe(12)
  if (data.version !== 12) throw new Error('wrong version')
  expect(data.inference.config).toEqual(estimationConfig)
  expect(data.inference.estimates).toHaveLength(2)
  expect(data.inference.estimates[0]).toMatchObject({ evaluatedAtMs: 1010, classifiedAtMs: 1011,
    stabilizedAtMs: 1011, classifiedState: 'walking', stabilizedState: 'unknown' })
  expect(data.inference.estimates[1].classifiedState).toBe('unknown')
  expect(() => readTransfer(JSON.stringify({ ...data, inference: { ...data.inference, expectedCount: 3 } }))).toThrow()
  expect(() => readTransfer(JSON.stringify({ ...data, inference: { ...data.inference,
    estimates: [{ ...data.inference.estimates[0], stabilizedAtMs: 1000 }] } }))).toThrow()
  expect(messageSchema.parse({ type: 'estimates', sessionId: metadata.sessionId, startIndex: 0,
    estimates: recorder.estimateBatch(0) }).type).toBe('estimates')
})

it('preserves version 2 raw-only files without inventing inference data', () => {
  const collector = new TransferCollector(metadata, 5000)
  collector.receive(0, [sample], 500); collector.updateStatus(1, completion)
  const { observationProtocol: _observationProtocol, management: _management, recovery: _recovery, questionnaires: _questionnaires, research: _research, inference: _inference, tasks: _tasks, ...raw } = collector.export()
  const version2 = { ...raw, version: 2 }
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(version2))))).toEqual(version2)
})
