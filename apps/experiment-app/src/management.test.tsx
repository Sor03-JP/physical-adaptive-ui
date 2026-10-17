import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ParticipantManager from './ParticipantManager'
import { prepareContinuation } from './continuation'
import { assessableTasks, assignments, createRoster, emptyManagement, managementSchema, nextStep } from './management'
import type { Group, Participant } from './management'
import { TransitTrial } from './tasks'
import type { TrialTaskId, TaskRun } from './tasks'
import { QuestionnaireBook } from './questionnaire'
import type { SurveyTarget } from './questionnaire'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'

const metadata = { sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }
const participant = (group: Group = 'G1'): Participant => ({ participantId: 'p01', group, rosterId: 'roster' })
function complete(id: string, taskId: TrialTaskId, mode: 'normal' | 'automatic', now = 0): TaskRun {
  const trial = new TransitTrial(id, 'session', taskId, now, mode)
  trial.present(now + 1); trial.begin(now + 2); trial.present(now + 3)
  trial.advance(now + 15003); trial.confirmStopped(now + 15004); trial.present(now + 15005)
  trial.answer('unknown', now + 15006)
  return trial.snapshot()
}
function submit(book: QuestionnaireBook, target: SurveyTarget, ids: string[], tasks: TaskRun[], now: number) {
  book.open(target, 'session', target, ids, now, tasks); book.present(target, now + 1)
  for (const item of book.active!.items.filter((i) => i.required)) book.answer(target, item.id, item.choices[0]!.value, now + 2)
  book.submit(target, now + 3)
}

describe('participant allocation and progress', () => {
  it('assigns ten anonymous IDs once with the agreed 3/2/2/3 group counts', () => {
    const roster = createRoster('roster', metadata.startedAt, () => 0.25)
    expect(roster.entries.map((p) => p.participantId)).toEqual(Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`))
    expect(['G1', 'G2', 'G3', 'G4'].map((g) => roster.entries.filter((p) => p.group === g).length)).toEqual([3, 2, 2, 3])
    expect(roster.entries.every((p) => p.rosterId === roster.id)).toBe(true)
    expect(roster.entries.filter((p) => assignments[p.group][0].mode === 'normal')).toHaveLength(5)
    expect(() => createRoster('r', metadata.startedAt, () => 1)).toThrow()
  })
  for (const group of ['G1', 'G2', 'G3', 'G4'] as const) it(`advances ${group} through practice, assigned tasks, condition surveys and final survey`, () => {
    const p = participant(group), management = emptyManagement(), book = new QuestionnaireBook(), tasks: TaskRun[] = []
    expect(nextStep(p, tasks, [], management)).toEqual({ kind: 'practice' })
    tasks.push(complete('practice', 'P1', 'automatic'))
    let now = 20000
    for (const block of assignments[group]) {
      const ids: string[] = []
      for (const n of [1, 2, 3]) {
        const taskId = `${block.set}${n}` as TrialTaskId, id = `${block.mode}${n}`
        expect(nextStep(p, tasks, book.snapshot(), management)).toEqual({ kind: 'task', taskId, mode: block.mode })
        const active = new TransitTrial(id, 'session', taskId, now, block.mode).snapshot()
        expect(nextStep(p, [...tasks, active], book.snapshot(), management)).toEqual({ kind: 'active', runId: id })
        tasks.push(complete(id, taskId, block.mode, now)); ids.push(id); now += 20000
      }
      expect(nextStep(p, tasks, book.snapshot(), management)).toEqual({ kind: 'survey', target: block.mode })
      submit(book, block.mode, ids, tasks, now); now += 100
    }
    expect(nextStep(p, tasks, book.snapshot(), management)).toEqual({ kind: 'survey', target: 'final' })
    submit(book, 'final', ['normal', 'automatic'], tasks, now)
    expect(nextStep(p, tasks, book.snapshot(), management)).toEqual({ kind: 'done' })
  })
  it('does not count a technically failed completed task as successful progress, while retaining its data', () => {
    const c = new TransferCollector(metadata, 5000)
    c.setParticipant(participant()); const original = complete('original', 'A1', 'normal', 20000)
    c.updateTask(complete('practice', 'P1', 'automatic')); c.updateTask(original)
    c.markFailure({ originalRunId: 'original', category: 'log-unavailable', reason: '表示ログの回収不能', recordedAtControllerMs: 40000 })
    expect(nextStep(participant(), c.taskRuns, [], c.management)).toEqual({ kind: 'task', taskId: 'A1', mode: 'normal' })
    expect(assessableTasks(c.progressTaskRuns, c.management).map((t) => t.id)).not.toContain('original')
    expect(c.taskRuns.find((t) => t.id === 'original')).toEqual(original)
    const retry = { ...c.management.failures[0]!, retryRunId: 'retry', consentConfirmed: true as const, requestedAtControllerMs: 40001 }
    c.requestRetry(retry)
    expect(() => c.requestRetry({ ...retry, retryRunId: 'again' })).toThrow()
    c.updateTask(complete('retry', 'A1', 'normal', 40000))
    expect(nextStep(participant(), c.taskRuns, [], c.management)).toEqual({ kind: 'task', taskId: 'A2', mode: 'normal' })
    const data = c.export()
    expect(readTransfer(writeTransfer(data))).toEqual(data)
    expect(data.tasks.find((t) => t.id === 'original')).toEqual(original)
    const wrong = structuredClone(data); wrong.tasks.find((t) => t.id === 'retry')!.mode = 'automatic'
    expect(() => readTransfer(JSON.stringify(wrong))).toThrow()
    c.markFailure({ originalRunId: 'retry', category: 'app-stopped', reason: '再実施中に停止', recordedAtControllerMs: 60000 })
    expect(() => c.requestRetry({ ...c.management.failures[1]!, retryRunId: 'third', consentConfirmed: true, requestedAtControllerMs: 60001 })).toThrow()
  })
  it('requires a real failure, reason and consent before accepting a retry record', () => {
    const failure = { originalRunId: 'one', category: 'app-stopped', reason: '停止', recordedAtControllerMs: 1 }
    const retry = { ...failure, retryRunId: 'two', consentConfirmed: true, requestedAtControllerMs: 2 }
    expect(managementSchema.safeParse({ ...emptyManagement(), failures: [failure], retries: [retry] }).success).toBe(true)
    for (const change of [{ consentConfirmed: false }, { reason: '' }, { requestedAtControllerMs: 0 }, { retryRunId: 'one' }])
      expect(managementSchema.safeParse({ ...emptyManagement(), failures: [failure], retries: [{ ...retry, ...change }] }).success).toBe(false)
    expect(managementSchema.safeParse({ ...emptyManagement(), retries: [retry] }).success).toBe(false)
  })
  it('keeps previous-session progress visible but only offers current-session tasks for failure and retry', () => {
    const old = new TransferCollector(metadata, 5000)
    old.setParticipant(participant()); old.updateTask(complete('previous', 'A1', 'normal'))
    old.updateStatus(0, { endedAtMs: 16000, stopReason: 'manual' })
    const current = new TransferCollector({ ...metadata, sessionId: 'resumed' }, 5000)
    current.continuation = prepareContinuation(old.export(), '接続確認', 20000, 'unused')
    current.management = structuredClone(current.continuation.management)
    current.updateTask({ ...complete('current', 'A2', 'normal'), sessionId: 'resumed' })
    const noop = () => {}
    const html = renderToStaticMarkup(<ParticipantManager variant="details" participant={participant()} selected={null}
      onSelect={noop} locked management={current.management} tasks={current.progressTaskRuns} retryTasks={current.taskRuns}
      surveys={[]} pending={false} retryDisabled={false} onFailure={noop} onRetry={noop} jsonExported={false} csvExported={false} verified={false} />)
    const options = html.match(/<select[^>]*>(.*?)<\/select>/s)![1]!
    expect(options).toContain('value="current"')
    expect(options).not.toContain('value="previous"')
    expect(current.progressTaskRuns.map((task) => task.id)).toEqual(['previous', 'current'])
  })
})
