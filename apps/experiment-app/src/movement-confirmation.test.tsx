import { expect, it } from 'vitest'
import { TransitTrial } from './tasks'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import { movementConfirmationSchema, latestMovementConfirmation } from './movement-confirmation'
import { prepareContinuation } from './continuation'
import { readExperimentFile, writeExperimentFile } from './experiment-file'
import type { LoadedCheckpoint } from './checkpoint'

const metadata = { sessionId: 'session', startedAt: '2026-10-17T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }
function completed(taskId: 'A1' | 'A2' | 'P1' = 'A2') {
  const trial = new TransitTrial('task', 'session', taskId, 1)
  trial.present(2); trial.begin(3); trial.present(4)
  trial.advance(15004); trial.confirmStopped(15005); trial.present(15006); trial.answer('unknown', 15007)
  return trial.snapshot()
}
function collector() {
  const c = new TransferCollector(metadata, 5000)
  c.updateTask(completed())
  return c
}
const asPlanned = { taskRunId: 'task', status: 'as-planned' as const, deviations: [] }

it('requires explicit confirmation, retains revision history and restores it with the PC clock', () => {
  const c = collector(), originalTask = c.taskRuns[0]
  expect(c.unconfirmedTaskRuns.map((t) => t.id)).toEqual(['task'])
  c.confirmMovement(asPlanned, 20000)
  expect(c.unconfirmedTaskRuns).toEqual([])
  c.confirmMovement({ taskRunId: 'task', status: 'deviation', deviations: [{ segments: ['4-11s'], comment: ' 歩き始めが遅れた ' }] }, 21000)
  expect(c.movementConfirmationHistory).toHaveLength(2)
  expect(latestMovementConfirmation(c.movementConfirmationHistory, 'task')).toMatchObject({ status: 'deviation', confirmedAtControllerMs: 21000,
    deviations: [{ segments: ['4-11s'], comment: '歩き始めが遅れた' }] })
  expect(c.taskRuns[0]).toEqual(originalTask)
  const disk: LoadedCheckpoint = { key: 'controller:room:session', savedAt: metadata.startedAt,
    header: c.checkpoint(0, 0).header, samples: [], estimates: [], sampleCount: 0, estimateCount: 0 }
  const restored = TransferCollector.restore(disk, 6000, 20001)
  expect(restored.movementConfirmationHistory).toEqual(c.movementConfirmationHistory)
  expect(readTransfer(writeTransfer(restored.export()))).toEqual(restored.export())
  expect(() => c.confirmMovement(asPlanned, 20999)).toThrow()
})

it('rejects incomplete deviations, invalid segments and confirmations for missing, active or practice tasks', () => {
  const c = collector()
  for (const deviations of [[], [{ segments: [], comment: '遅れた' }], [{ segments: ['4-11s'], comment: ' ' }],
    [{ segments: ['all', '4-11s'], comment: '遅れた' }], [{ segments: ['4-11s', '4-11s'], comment: '遅れた' }]]) {
    expect(movementConfirmationSchema.safeParse({ taskRunId: 'task', status: 'deviation', deviations, confirmedAtControllerMs: 10 }).success).toBe(false)
  }
  expect(() => c.confirmMovement({ ...asPlanned, taskRunId: 'missing' }, 10)).toThrow()
  const active = new TransferCollector(metadata, 5000)
  active.updateTask(new TransitTrial('task', 'session', 'A2', 1).snapshot())
  expect(() => active.confirmMovement(asPlanned, 10)).toThrow()
  const practice = new TransferCollector(metadata, 5000); practice.updateTask(completed('P1'))
  expect(practice.unconfirmedTaskRuns).toEqual([])
  expect(() => practice.confirmMovement(asPlanned, 20000)).toThrow()
  const staticTask = new TransferCollector(metadata, 5000); staticTask.updateTask(completed('A1'))
  expect(() => staticTask.confirmMovement({ taskRunId: 'task', status: 'deviation', deviations: [{ segments: ['4-11s'], comment: '途中で歩いた' }] }, 20000)).toThrow()
  staticTask.confirmMovement({ taskRunId: 'task', status: 'deviation', deviations: [{ segments: ['all'], comment: '途中で歩いた' }] }, 20000)
  expect(() => readTransfer(JSON.stringify({ ...c.export(), movementConfirmations: [{ ...asPlanned, taskRunId: 'missing', confirmedAtControllerMs: 10 }] }))).toThrow()
})

it('reads version 12 without backfilling confirmations and upgrades checkpoints as unconfirmed', () => {
  const c = collector()
  const { movementConfirmations: _confirmations, ...rest } = c.export()
  const old = { ...rest, version: 12, observationProtocol: { method: 'state-confirmation', instructionTiming: { firstMs: 4000, secondMs: 11000 } } }
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(old))))).toEqual(old)
  const saved: LoadedCheckpoint = { key: 'controller:room:session', savedAt: metadata.startedAt,
    header: old, samples: [], estimates: [], sampleCount: 0, estimateCount: 0 }
  const before = structuredClone(saved)
  const restored = TransferCollector.restore(saved, 6000, 20000)
  expect(restored.movementConfirmationHistory).toEqual([])
  expect(restored.unconfirmedTaskRuns).toHaveLength(1)
  expect(saved).toEqual(before)
})

it('keeps confirmations in their original session when exporting continued recordings', () => {
  const c = collector()
  c.setParticipant({ participantId: 'test01', group: 'G1', rosterId: 'test' })
  c.confirmMovement(asPlanned, 20000); c.updateStatus(0, { endedAtMs: 16000, stopReason: 'manual' })
  const old = c.export()
  const next = new TransferCollector({ ...metadata, sessionId: 'next' }, 5000)
  next.continuation = prepareContinuation(old, '接続確認後に続行', 21000, 'retry')
  next.management = next.continuation.management
  const records = readExperimentFile(writeExperimentFile([old, next.export()]))
  expect(records[0]).toEqual(old)
  expect(next.movementConfirmationHistory).toEqual([])
  expect(next.unconfirmedTaskRuns).toEqual([])
})
