import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { prepareContinuation, continuationIntentSchema } from './continuation'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import { TransitTrial } from './tasks'
import type { TrialTaskId } from './tasks'
import { nextStep } from './management'
import { QuestionnaireBook, conditionTaskIds } from './questionnaire'
import { messageSchema } from './protocol'
import { phoneArchiveSchema } from './phone-checkpoint'
import { loadExperimentRecords, readExperimentFile, writeExperimentFile } from './experiment-file'
import ContinuationPanel from './ContinuationPanel'
import type { LoadedCheckpoint, StoredCheckpoint } from './checkpoint'
import { writeQuestionnaireCsv } from './questionnaire-csv'

const participant = { participantId: 'test01', group: 'G1' as const, rosterId: 'rehearsal' }
const metadata = { sessionId: 'old', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }
function task(id: string, taskId: TrialTaskId, sessionId: string, now: number, finish = true) {
  const t = new TransitTrial(id, sessionId, taskId, now, taskId === 'P1' || taskId.startsWith('B') ? 'automatic' : 'normal')
  t.present(now + 1); t.begin(now + 2); t.present(now + 3)
  if (finish) { t.advance(now + 15003); t.confirmStopped(now + 15004); t.present(now + 15005); t.answer('unknown', now + 15006) }
  else t.abort(now + 100, 'page-hidden')
  return t.snapshot()
}
function stopped() {
  const c = new TransferCollector(metadata, 5000)
  c.setParticipant(participant)
  c.updateTask(task('practice', 'P1', 'old', 1))
  c.updateTask(task('done', 'A1', 'old', 20000))
  c.updateTask(task('interrupted', 'A2', 'old', 40000, false))
  c.updateStatus(0, { endedAtMs: 50000, stopReason: 'page-hidden' })
  return c
}
function continued() {
  const old = stopped()
  const context = prepareContinuation(old.export(), '画面が非表示になった', 60000, 'retry')
  old.management = structuredClone(context.management)
  const c = new TransferCollector({ ...metadata, sessionId: 'new', timeOriginMs: 100000 }, 5000)
  c.continuation = context; c.management = structuredClone(context.management)
  return { old, c, context }
}

it('preserves completed work, keeps failed data and links just the interrupted task to one retry', () => {
  const original = stopped().export(), before = structuredClone(original)
  const context = prepareContinuation(original, '画面非表示', 60000, 'retry')
  expect(original).toEqual(before)
  expect(context.tasks).toEqual(original.tasks)
  expect(context.management.failures[0]?.originalRunId).toBe('interrupted')
  expect(context.management.retries[0]).toMatchObject({ originalRunId: 'interrupted', retryRunId: 'retry', consentConfirmed: true })
  expect(nextStep(participant, context.tasks, context.questionnaires, context.management)).toEqual({ kind: 'task', taskId: 'A2', mode: 'normal' })
  expect(continuationIntentSchema.parse({ sessionId: 'new', context }).context.participant).toEqual(participant)
  expect(messageSchema.parse({ type: 'start', sessionId: 'new', participant, continuation: context }).type).toBe('start')
  expect(messageSchema.parse({ type: 'clear', sessionId: 'old', forContinuation: true }).type).toBe('clear')
})

it('continues questionnaires across different phone clocks without rewriting previous task times', () => {
  const { old, c, context } = continued()
  c.updateTask(task('retry', 'A2', 'new', 10))
  c.updateTask(task('last', 'A3', 'new', 20000))
  const book = new QuestionnaireBook(context)
  const ids = conditionTaskIds(c.assessableTaskRuns, 'normal')
  expect(ids).toEqual(['done', 'retry', 'last'])
  book.open('normal-survey', 'new', 'normal', ids, 40000, c.assessableTaskRuns)
  book.present('normal-survey', 40001)
  for (const item of book.active!.items) book.answer('normal-survey', item.id, 3, 40002)
  book.submit('normal-survey', 40003)
  expect(c.updateQuestionnaires(book.snapshot())).toBe(true)
  expect(nextStep(participant, c.progressTaskRuns, c.progressSurveyRuns, c.management)).toEqual({ kind: 'task', taskId: 'B1', mode: 'automatic' })
  expect(readTransfer(writeTransfer(c.export()))).toEqual(c.export())
  expect(c.export().continuation?.tasks[1]).toEqual(old.export().tasks[1])
  expect(phoneArchiveSchema.safeParse({ format: 'physical-adaptive-phone-checkpoint', version: 1, metadata: c.metadata,
    participant, completion: null, config: null, savedThroughMs: 50000, tasks: c.taskRuns, questionnaires: book.snapshot(), continuation: context,
    samples: [], estimates: [] }).success).toBe(true)
})

it('keeps submitted surveys and repeats only unfinished surveys', () => {
  const { c } = continued()
  c.updateTask(task('retry', 'A2', 'new', 10)); c.updateTask(task('last', 'A3', 'new', 20000))
  const book = new QuestionnaireBook(c.continuation)
  book.open('survey', 'new', 'normal', conditionTaskIds(c.assessableTaskRuns, 'normal'), 40000, c.assessableTaskRuns)
  book.present('survey', 40001); book.answer('survey', 'q1', 4, 40002)
  c.updateQuestionnaires(book.snapshot()); c.updateStatus(0, { endedAtMs: 50000, stopReason: 'manual' })
  expect(prepareContinuation(c.export(), '接続確認', 70000, 'unused').questionnaires).toEqual([])
  for (const item of book.active!.items) book.answer('survey', item.id, 3, 40003)
  book.submit('survey', 40004); c.updateQuestionnaires(book.snapshot())
  const context = prepareContinuation(c.export(), '接続確認', 70000, 'unused')
  expect(context.questionnaires).toEqual(book.snapshot())
  expect(nextStep(participant, context.tasks, context.questionnaires, context.management)).toEqual({ kind: 'task', taskId: 'B1', mode: 'automatic' })
})

it('does not retry a retry, or continue an uncollected active session', () => {
  const { c } = continued()
  expect(() => prepareContinuation(c.export(), '中断', 70000, 'another')).toThrow('停止後')
  c.updateTask(task('retry', 'A2', 'new', 10, false)); c.updateStatus(0, { endedAtMs: 1000, stopReason: 'page-hidden' })
  expect(() => prepareContinuation(c.export(), '再停止', 70000, 'another')).toThrow('再実施の再実施')
})

it('retains a pending retry when recording stops before that task starts', () => {
  const { c, context } = continued()
  c.updateStatus(0, { endedAtMs: 10, stopReason: 'page-hidden' })
  const again = prepareContinuation(c.export(), '開始前に画面非表示', 70000, 'unused')
  expect(again.resumeRunId).toBe(context.resumeRunId)
  expect(again.management.retries).toHaveLength(1)
  expect(nextStep(participant, again.tasks, again.questionnaires, again.management)).toEqual({ kind: 'task', taskId: 'A2', mode: 'normal' })
})

it('offers practice again after a frozen practice while preserving its original snapshot', () => {
  const original = new TransferCollector(metadata, 5000); original.setParticipant(participant)
  const frozen = new TransitTrial('practice', 'old', 'P1', 0).snapshot()
  original.updateTask(frozen); original.recovery = { phoneSavedThroughMs: 10, detectedAt: metadata.startedAt }
  const context = prepareContinuation(original.export(), '練習中に更新', 100, 'unused')
  const current = new TransferCollector({ ...metadata, sessionId: 'new' }, 5000)
  current.continuation = context; current.management = structuredClone(context.management)
  expect(nextStep(participant, current.progressTaskRuns, current.progressSurveyRuns, current.management)).toEqual({ kind: 'practice' })
  expect(current.continuation.tasks).toEqual([frozen])
})

it('recovers frozen phone trials without inventing an abort timestamp', () => {
  const c = new TransferCollector(metadata, 5000)
  c.setParticipant(participant)
  c.updateTask(task('practice', 'P1', 'old', 1)); c.updateTask(task('done1', 'A1', 'old', 20000)); c.updateTask(task('done2', 'A2', 'old', 40000))
  const viewing = new TransitTrial('frozen', 'old', 'A3', 60000).snapshot()
  c.updateTask(viewing); c.recovery = { phoneSavedThroughMs: 65000, detectedAt: metadata.startedAt }
  const context = prepareContinuation(c.export(), 'iPhone更新', 70000, 'retry-frozen')
  expect(context.tasks.at(-1)).toEqual(viewing)
  expect(nextStep(participant, context.tasks, context.questionnaires, context.management)).toEqual({ kind: 'task', taskId: 'A3', mode: 'normal' })
})

it('carries a submitted first-condition survey across a restarted phone clock and reaches the final survey', () => {
  const root = new TransferCollector(metadata, 5000); root.setParticipant(participant)
  root.updateTask(task('p', 'P1', 'old', 1))
  for (const [index, id] of ['A1', 'A2', 'A3'].entries()) root.updateTask(task(id, id as TrialTaskId, 'old', 20000 + index * 20000))
  const first = new QuestionnaireBook()
  first.open('normal', 'old', 'normal', ['A1', 'A2', 'A3'], 80000, root.taskRuns); first.present('normal', 80001)
  for (const item of first.active!.items) first.answer('normal', item.id, 3, 80002)
  first.submit('normal', 80003); root.updateQuestionnaires(first.snapshot())
  root.updateTask(task('failed-b1', 'B1', 'old', 90000, false)); root.updateStatus(0, { endedAtMs: 100000, stopReason: 'page-hidden' })
  const context = prepareContinuation(root.export(), '画面非表示', 200000, 'retry-b1')
  const current = new TransferCollector({ ...metadata, sessionId: 'new', timeOriginMs: 999000 }, 5000)
  current.continuation = context; current.management = structuredClone(context.management)
  for (const [index, id] of ['B1', 'B2', 'B3'].entries()) current.updateTask(task(index === 0 ? 'retry-b1' : id, id as TrialTaskId, 'new', 1 + index * 16000))
  const second = new QuestionnaireBook(context)
  second.open('automatic', 'new', 'automatic', conditionTaskIds(current.assessableTaskRuns, 'automatic'), 50000, current.assessableTaskRuns)
  second.present('automatic', 50001)
  for (const item of second.active!.items) second.answer('automatic', item.id, 3, 50002)
  second.submit('automatic', 50003); expect(current.updateQuestionnaires(second.snapshot())).toBe(true)
  second.open('final', 'new', 'final', ['normal', 'automatic'], 50004, current.assessableTaskRuns); second.present('final', 50005)
  second.answer('final', 'comparison', second.active!.items[0]!.choices[0]!.value, 50006); second.submit('final', 50007)
  expect(current.updateQuestionnaires(second.snapshot())).toBe(true)
  expect(nextStep(participant, current.progressTaskRuns, current.progressSurveyRuns, current.management)).toEqual({ kind: 'done' })
  expect(readTransfer(writeTransfer(current.export()))).toEqual(current.export())
})

it('keeps interrupted and resubmitted survey answers as separate rows in the final CSV', () => {
  const root = new QuestionnaireBook(), resumed = new QuestionnaireBook()
  const oldTasks = ['A1', 'A2', 'A3'].map((id, index) => task(id, id as TrialTaskId, 'old', 1 + index * 16000))
  root.open('partial', 'old', 'normal', oldTasks.map((t) => t.id), 50000, oldTasks); root.present('partial', 50001); root.answer('partial', 'q1', 5, 50002)
  const newTasks = oldTasks.map((t) => ({ ...t, sessionId: 'new' }))
  resumed.open('resent', 'new', 'normal', newTasks.map((t) => t.id), 50000, newTasks); resumed.present('resent', 50001)
  for (const item of resumed.active!.items) resumed.answer('resent', item.id, 2, 50002)
  resumed.submit('resent', 50003)
  const csv = writeQuestionnaireCsv([...root.snapshot(), ...resumed.snapshot()], participant)
  expect(csv).toContain('"old","partial","normal","answering"')
  expect(csv).toContain('"new","resent","normal","submitted"')
  expect(csv.split('\r\n').filter(Boolean)).toHaveLength(11)
})

it('exports original and continued records together and refuses a missing or unrelated parent', async () => {
  const { old, c } = continued()
  const delta = old.checkpoint(0, 0)
  const saved: LoadedCheckpoint = { key: 'old-key', header: delta.header, savedAt: metadata.startedAt, sampleCount: 0, estimateCount: 0, samples: [], estimates: [] }
  const journal = { list: async (): Promise<StoredCheckpoint[]> => [saved], load: async () => saved }
  const before = structuredClone(saved)
  const records = await loadExperimentRecords(c.export(), journal)
  expect(records.map((record) => record.metadata.sessionId)).toEqual(['old', 'new'])
  expect(readExperimentFile(writeExperimentFile(records))).toEqual(records)
  expect(readExperimentFile(writeExperimentFile([old.export()]))).toEqual([old.export()])
  expect(saved).toEqual(before)
  await expect(loadExperimentRecords(c.export(), { list: async () => [], load: async () => null })).rejects.toThrow('見つかりません')
  const wrong = structuredClone(records); wrong[0]!.metadata.sessionId = 'other'
  expect(() => writeExperimentFile(wrong)).toThrow()
})

it('shows a separate continuation action without requiring JSON export', () => {
  const html = renderToStaticMarkup(<ContinuationPanel participantId="test01" disabled={false} onContinue={() => {}} />)
  expect(html).toContain('今はJSONのダウンロード・ファイル確認は不要')
  expect(html).toContain('完了済み課題・送信済みアンケートを引き継ぎ')
  expect(html).toMatch(/disabled=""[^>]*>元の記録を端末に保管して/)
})
