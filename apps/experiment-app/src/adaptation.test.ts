import { expect, it } from 'vitest'
import { TransitTrial, taskRunSchema } from './tasks'

function preparedTrial(...args: ConstructorParameters<typeof TransitTrial>) {
  const trial = new TransitTrial(...args)
  trial.present(args[3]); trial.begin(args[3])
  return trial
}
import { messageSchema } from './protocol'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import type { PhysicalState } from '@physical-adaptive/core'

const estimate = (state: PhysicalState, atMs: number) => ({ evaluatedAtMs: atMs, stabilizedAtMs: atMs, stabilizedState: state })
const metrics = { rowHeightPx: 64, fontSizePx: 20, viewportHeightPx: 700 }

it('fixes normal UI while preserving the real stable state and its estimate reference', () => {
  const trial = preparedTrial('fixed', 'session', 'A1', 0, 'normal')
  trial.updateAdaptation(estimate('running', 100), 101)
  trial.present(110, metrics)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ state: 'stationary', appliedState: 'stationary',
    inputState: 'running', reason: 'fixed', estimateAtMs: 100, decidedAtMs: 101, appliedAtMs: 110, surface: 'information', metrics })
})

it('follows stable context, holds unknown for 1 second, falls back, and recovers without altering inference', () => {
  const trial = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  trial.present(0)
  expect(trial.snapshot().uiDecision).toMatchObject({ state: 'stationary', inputState: 'unknown', reason: 'initial' })
  trial.updateAdaptation(estimate('walking', 100), 101)
  expect(trial.snapshot().uiLog.at(-1)?.appliedState).toBe('stationary') // not committed yet
  trial.present(110, metrics); trial.present(111, metrics)
  expect(trial.snapshot().uiLog).toHaveLength(3)
  trial.updateAdaptation(estimate('unknown', 200), 201); trial.present(210)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ appliedState: 'walking', inputState: 'unknown', reason: 'unknown-hold' })
  trial.updateAdaptation(estimate('unknown', 1100), 1199); trial.present(1199)
  expect(trial.snapshot().uiLog.at(-1)?.appliedState).toBe('walking')
  trial.updateAdaptation(estimate('unknown', 1200), 1200); trial.present(1201)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ appliedState: 'stationary', inputState: 'unknown', reason: 'unknown-fallback' })
  trial.updateAdaptation(estimate('running', 1400), 1401); trial.present(1410)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ appliedState: 'running', reason: 'estimated' })
  expect(taskRunSchema.parse(trial.snapshot())).toEqual(trial.snapshot())
})

it('retains common stop-wait and answer UI even when stable context is running', () => {
  const trial = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  trial.updateAdaptation(estimate('running', 0), 0); trial.present(0)
  // The old information DOM has committed after the deadline; wait for the new common screen before logging it.
  trial.present(20000)
  expect(trial.snapshot().uiLog.at(-1)?.surface).toBe('information')
  trial.present(20001)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ surface: 'common', appliedState: 'stationary', inputState: 'running' })
  trial.confirmStopped(21000); trial.updateAdaptation(estimate('running', 21000), 21001); trial.present(21002)
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ surface: 'common', appliedState: 'stationary', phase: 'answering' })
})

it('exports both modes with UI profiles, applied times and dimensions, and rejects corrupt UI time', () => {
  const collector = new TransferCollector({ sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 0,
    startedAtMs: 0, userAgent: 'test' }, 1000)
  for (const mode of ['normal', 'automatic'] as const) {
    const trial = preparedTrial(mode, 'session', 'A1', 0, mode)
    trial.updateAdaptation(estimate('walking', 10), 11); trial.present(12, metrics)
    collector.updateTask(trial.snapshot())
    expect(taskRunSchema.safeParse({ ...trial.snapshot(), uiLog: [{ ...trial.snapshot().uiLog.at(-1)!, appliedAtMs: 1 }] }).success).toBe(false)
  }
  const data = collector.export()
  expect(readTransfer(writeTransfer(data))).toEqual(data)
  expect(data.tasks.map((task) => task.uiLog.at(-1)!.appliedState)).toEqual(['stationary', 'walking'])
  expect(data.tasks[1].uiConfig).toMatchObject({ unknownHoldMs: 1000, profiles: { running: { rowHeightPx: 72, fontSizePx: 24 } } })
  expect(messageSchema.parse({ type: 'task-start', sessionId: 'session', runId: 'auto', taskId: 'A1', mode: 'automatic' })).toMatchObject({ mode: 'automatic' })
})

it('does not label a superseded React commit as the application of a newer decision', () => {
  const trial = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  trial.present(0)
  const oldRender = trial.snapshot()
  trial.updateAdaptation(estimate('running', 100), 101)
  expect(trial.present(110, metrics, { phase: oldRender.phase, decisionKey: JSON.stringify(oldRender.uiDecision), selectedTrainIndex: oldRender.selectedTrainIndex })).toBe(true)
  expect(trial.snapshot().uiLog).toHaveLength(2)
  const latestRender = trial.snapshot()
  trial.present(120, metrics, { phase: latestRender.phase, decisionKey: JSON.stringify(latestRender.uiDecision), selectedTrainIndex: latestRender.selectedTrainIndex })
  expect(trial.snapshot().uiLog.at(-1)).toMatchObject({ appliedState: 'running', appliedAtMs: 120, decidedAtMs: 101 })
})
