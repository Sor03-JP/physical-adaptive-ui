import { describe, expect, it } from 'vitest'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import type { MotionSample } from '@physical-adaptive/device-motion'

const metadata = { sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z',
  timeOriginMs: 1000, startedAtMs: 10, userAgent: 'phone' }
const sample: MotionSample = { receivedAtMs: 20, eventTimestampMs: 19, reportedIntervalRaw: 0.01666666753590107, receivedIntervalMs: null,
  acceleration: { x: 0, y: null, z: 1 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, rotationRate: null }
const completion = { endedAtMs: 30, stopReason: 'manual' as const }

describe('PC transfer collector', () => {
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
  const legacy = { ...original, version: 1, samples: original.samples.map(
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
