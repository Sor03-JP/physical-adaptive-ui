import { expect, it } from 'vitest'
import { ResearchRecorder } from './research-log'

it('distinguishes instructions, observed transitions, confirmation and missing observation without backdating', () => {
  const recorder = new ResearchRecorder()
  for (const event of [
    { kind: 'instruction' as const, value: 'walking' as const, controllerAtMs: 100 },
    { kind: 'observation' as const, value: 'transition' as const, controllerAtMs: 300 },
    { kind: 'observation' as const, value: 'walking' as const, controllerAtMs: 1400 },
    { kind: 'observation' as const, value: 'missed' as const, controllerAtMs: 1500 },
  ]) recorder.record({ ...event, taskRunId: null, reportedPhase: null })
  expect(recorder.snapshot().events.map((e) => e.controllerAtMs)).toEqual([100, 300, 1400, 1500])
  expect(() => recorder.record({ kind: 'instruction', value: 'uncertain', controllerAtMs: 1600, taskRunId: null, reportedPhase: null })).toThrow()
  const snapshot = recorder.snapshot(); snapshot.events.length = 0
  expect(recorder.snapshot().events).toHaveLength(4)
})
