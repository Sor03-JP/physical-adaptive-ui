import { expect, it } from 'vitest'
import { TransferCollector, checkpointTransfer, readTransfer, writeTransfer } from './transfer'
import { readPhoneCheckpoint } from './phone-checkpoint'
import { TransitTrial } from './tasks'
import type { LoadedCheckpoint, CheckpointDelta } from './checkpoint'
import type { MotionSample } from '@physical-adaptive/device-motion'

const metadata = { sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 10, userAgent: 'phone' }
const sample: MotionSample = { receivedAtMs: 20, eventTimestampMs: 19, reportedIntervalRaw: 0.01666666753590107, receivedIntervalMs: null,
  acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 }, rotationRate: null }
function saved(delta: CheckpointDelta, samples = delta.samples, estimates = delta.estimates): LoadedCheckpoint {
  return { key: `controller:room:${delta.sessionId}`, savedAt: '2026-10-16T00:00:01.000Z', header: structuredClone(delta.header),
    samples: structuredClone(samples), estimates: structuredClone(estimates), sampleCount: samples.length, estimateCount: estimates.length }
}

it('keeps v11 files unchanged and restores old checkpoints without assuming the new observation method', () => {
  const c = new TransferCollector(metadata, 5000)
  c.research.record({ kind: 'instruction', value: 'walking', controllerAtMs: 51, taskRunId: null, reportedPhase: null })
  const current = c.export()
  expect(current.observationProtocol).toEqual({ method: 'post-task-confirmation', instructionTiming: { firstMs: 4000, secondMs: 11000 } })
  expect(current.research.events).toHaveLength(1)
  const { movementConfirmations: _movementConfirmations, observationProtocol: _protocol, ...previous } = current
  const old = { ...previous, version: 11 }
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(old))))).toEqual(old)
  const disk = { ...saved(c.checkpoint(0, 0)), header: old }
  const before = structuredClone(disk)
  const restored = TransferCollector.restore(disk, 6000, 20).export()
  expect(restored.version).toBe(14)
  expect(restored.observationProtocol).toBeNull()
  expect(restored.research.events).toEqual(old.research.events)
  expect(disk).toEqual(before)
  const previousCheckpoint = { ...saved(c.checkpoint(0, 0)), header: { ...current, version: 13 } }
  const resumed = TransferCollector.restore(previousCheckpoint, 6000, 20).export()
  expect(resumed.version).toBe(14)
  expect(resumed.research).toEqual(current.research)
  expect(resumed.observationProtocol).toEqual(current.observationProtocol)
})

it('restores PC incremental checkpoints without changing raw times, and receives only missing batches', () => {
  const c = new TransferCollector(metadata, 5000)
  c.setParticipant({ participantId: 'p01', group: 'G4', rosterId: 'roster' })
  c.receive(0, [sample], 50); c.updateStatus(3, null)
  c.research.record({ kind: 'observation', value: 'stationary', controllerAtMs: 51, taskRunId: null, reportedPhase: null })
  const first = c.checkpoint(0, 0)
  const secondSample = { ...sample, receivedAtMs: 25, receivedIntervalMs: 5 }
  c.receive(1, [secondSample], 60)
  const second = c.checkpoint(1, 0)
  expect(second.samples).toEqual([secondSample])
  const disk = saved(second, [...first.samples, ...second.samples])
  expect(checkpointTransfer(disk)).toEqual(c.export())
  const before = structuredClone(disk)
  const restored = TransferCollector.restore(disk, 6000, 20)
  expect(restored.export().samples).toEqual([sample, secondSample])
  expect(restored.export().receipts).toEqual(c.export().receipts)
  expect(restored.export().research).toEqual({ clock: 'controller-local-performance', events: c.export().research.events })
  expect(restored.management).toMatchObject({ participant: { participantId: 'p01', group: 'G4' }, controllerRestarts: [{ timeOriginMs: 6000, controllerAtMs: 1020 }] })
  expect(restored.receive(0, [sample], 1021)).toBe(false)
  expect(restored.receive(2, [{ ...sample, receivedAtMs: 30, receivedIntervalMs: 5 }], 1022)).toBe(true)
  restored.updateStatus(3, { endedAtMs: 35, stopReason: 'manual' })
  expect(restored.complete).toBe(true)
  expect(readTransfer(writeTransfer(restored.export()))).toEqual(restored.export())
  expect(disk).toEqual(before)
})

it('recovers phone data with its original clock and rejects mixed sessions, wrong timing and counts', () => {
  const trial = new TransitTrial('trial', 'session', 'A1', 11)
  const header = { format: 'physical-adaptive-phone-checkpoint', version: 1, metadata, participant: null,
    completion: null, config: null, savedThroughMs: 30, tasks: [trial.snapshot()], questionnaires: [] }
  const disk = saved({ sessionId: 'session', header, sampleStart: 0, estimateStart: 0, samples: [sample], estimates: [] })
  const before = structuredClone(disk), recovered = readPhoneCheckpoint(disk)
  expect(recovered.metadata).toEqual(metadata); expect(recovered.samples).toEqual([sample]); expect(recovered.completion).toBeNull()
  expect(recovered.tasks[0].phase).toBe('briefing') // Does not invent an abort time or continue a task.
  expect(disk).toEqual(before)
  expect(() => readPhoneCheckpoint({ ...disk, header: { ...header, savedThroughMs: 19 } })).toThrow()
  expect(() => readPhoneCheckpoint({ ...disk, header: { ...header, metadata: { ...metadata, sessionId: 'other' } } })).toThrow()
  expect(() => readPhoneCheckpoint({ ...disk, header: { ...header, completion: { endedAtMs: 19, stopReason: 'manual' } } })).toThrow()
  const pc = new TransferCollector(metadata, 5000); pc.receive(0, [sample], 50)
  const good = saved(pc.checkpoint(0, 0))
  expect(() => checkpointTransfer({ ...good, samples: [] })).toThrow()
})

it('keeps newer task snapshots on recovery, accepts later terminal UI commits, and preserves old version 10 files', () => {
  const c = new TransferCollector(metadata, 5000), trial = new TransitTrial('trial', 'session', 'A1', 11)
  const oldest = trial.snapshot(); c.updateTask(oldest)
  trial.present(12); trial.begin(13); trial.present(14)
  const viewing = trial.snapshot(); expect(c.updateTask(viewing)).toBe(true)
  expect(c.updateTask(oldest)).toBe(false)
  trial.abort(15, 'technical'); const ended = trial.snapshot(); c.updateTask(ended)
  expect(c.updateTask(viewing)).toBe(false)
  trial.present(16); expect(c.updateTask(trial.snapshot())).toBe(true)
  expect(c.taskRuns[0].uiLog.at(-1)?.appliedAtMs).toBe(16)
  c.recovery = { phoneSavedThroughMs: 14, detectedAt: metadata.startedAt }
  c.receive(0, [sample], 50); c.updateStatus(0, { endedAtMs: 14, stopReason: 'recovered-after-reload' })
  expect(c.export().completion!.endedAtMs).toBe(20) // Retain newer samples already received by PC.
  expect(readTransfer(writeTransfer(c.export()))).toEqual(c.export())
  const { management: _management, recovery: _recovery, movementConfirmations: _movementConfirmations, observationProtocol: _observationProtocol, ...v10 } = c.export()
  const old = { ...v10, version: 10 }
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(old))))).toEqual(old)
})
