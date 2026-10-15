import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuestionnaireBook, canSubmitSurvey, conditionTaskIds, surveyListSchema, surveyRunSchema } from './questionnaire'
import type { SurveyRun } from './questionnaire'
import { TransitTrial } from './tasks'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import QuestionnaireScreen from './QuestionnaireScreen'
import QuestionnaireController from './QuestionnaireController'

function tasks(mode: 'normal' | 'automatic', set: 'A' | 'B', start: number) {
  return ([1, 2, 3] as const).map((n) => {
    const time = start + (n - 1) * 21000
    const trial = new TransitTrial(`${mode}-${set}${n}`, 'session', `${set}${n}`, time, mode)
    trial.present(time); trial.begin(time + 1); trial.present(time + 2)
    trial.advance(time + 20002); trial.confirmStopped(time + 20003); trial.present(time + 20004)
    trial.answer('unknown', time + 20005)
    return trial.snapshot()
  })
}
const fixedTasks = tasks('normal', 'A', 0)
const autoTasks = tasks('automatic', 'B', 80000)
const allTasks = [...fixedTasks, ...autoTasks]
function open(book: QuestionnaireBook, target: 'normal' | 'automatic', now: number) {
  book.open(target, 'session', target, conditionTaskIds(allTasks, target), now, allTasks)
  book.present(target, now + 1)
}
function finish(book: QuestionnaireBook, now: number) {
  const run = book.active!
  run.items.filter((item) => item.required).forEach((item, i) =>
    book.answer(run.id, item.id, item.id === 'comparison' ? 'no-difference' : item.id === 'q6' ? 'cannot-judge' : 3, now + i))
  book.submit(run.id, now + 10)
}
function completedBook() {
  const book = new QuestionnaireBook()
  open(book, 'normal', 70000); finish(book, 70010)
  open(book, 'automatic', 150000); finish(book, 150010)
  book.open('final', 'session', 'final', ['normal', 'automatic'], 160000, allTasks)
  book.present('final', 160001); finish(book, 160010)
  return book
}

describe('questionnaires tied to task records', () => {
  it('keeps blank answers and requires five common items, with no default ratings', () => {
    const book = new QuestionnaireBook()
    open(book, 'normal', 70000)
    expect(book.active?.items).toHaveLength(5)
    expect(book.active?.answers).toEqual({})
    book.submit('normal', 70002)
    expect(book.active?.phase).toBe('answering')
    expect(canSubmitSurvey(book.active!)).toBe(false)
    book.answer('normal', 'q1', 5, 70003)
    expect(() => book.answer('normal', 'q6', 5, 70004)).toThrow()
    expect(() => book.answer('normal', 'q1', 'cannot-judge', 70004)).toThrow()
    finish(book, 70010)
    expect(book.active?.phase).toBe('submitted')
  })
  it('keeps cannot-judge distinct from numeric answers and ignores duplicate opens/submissions', () => {
    const book = new QuestionnaireBook()
    open(book, 'automatic', 150000)
    book.answer('automatic', 'q6', 'cannot-judge', 150002)
    book.open('automatic', 'session', 'automatic', conditionTaskIds(allTasks, 'automatic'), 150003, allTasks)
    expect(book.active?.answers.q6).toBe('cannot-judge')
    finish(book, 150010)
    const saved = book.snapshot()
    book.answer('automatic', 'q1', 1, 150100); book.submit('automatic', 150101)
    book.open('automatic', 'session', 'automatic', conditionTaskIds(allTasks, 'automatic'), 150200, allTasks)
    expect(book.snapshot()).toEqual(saved)
    expect(() => book.open('another', 'session', 'automatic', conditionTaskIds(allTasks, 'automatic'), 150300, allTasks)).toThrow()
  })
  it('does not mix problem sets or open final comparison before both condition surveys', () => {
    const book = new QuestionnaireBook()
    expect(conditionTaskIds([fixedTasks[0]!, fixedTasks[1]!, tasks('normal', 'B', 0)[2]!], 'normal')).toEqual([])
    expect(() => book.open('bad', 'session', 'normal', [fixedTasks[0]!.id, fixedTasks[1]!.id, autoTasks[2]!.id], 150000, allTasks)).toThrow()
    expect(() => book.open('early', 'session', 'final', ['normal', 'automatic'], 150000, allTasks)).toThrow()
    open(book, 'normal', 70000)
    expect(() => open(book, 'automatic', 150000)).toThrow()
    finish(book, 150010)
    expect(surveyListSchema.parse(book.snapshot())).toHaveLength(1)
  })
  it('saves final comparison and optional free text without converting them to a score', () => {
    const book = completedBook()
    const last = book.active!
    expect(last.answers).toEqual({ comparison: 'no-difference' })
    expect(last.items.find((item) => item.id === 'comment')?.required).toBe(false)
    expect(surveyListSchema.parse(book.snapshot())).toHaveLength(3)
    const snapshot = book.snapshot(); snapshot[0]!.answers.q1 = 1
    expect(book.snapshot()[0]!.answers.q1).toBe(3)
    expect(() => surveyRunSchema.parse({ ...last, submittedAtMs: last.requestedAtMs - 1 })).toThrow()
    expect(() => surveyRunSchema.parse({ ...last, answers: {} })).toThrow()
  })
  it('preserves all answers, item wording and links through JSON; accepts older version 8 unchanged', () => {
    const collector = new TransferCollector({ sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z',
      timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }, 5000)
    for (const task of allTasks) collector.updateTask(task)
    collector.updateStatus(0, { endedAtMs: 180000, stopReason: 'manual' })
    const book = completedBook()
    expect(collector.updateQuestionnaires(book.snapshot())).toBe(true)
    const data = collector.export()
    expect(data.version).toBe(11)
    expect(readTransfer(writeTransfer(data))).toEqual(data)
    expect(data.questionnaires[1]?.answers.q6).toBe('cannot-judge')
    expect(data.questionnaires[2]?.linkedIds).toEqual(['normal', 'automatic'])
    const corrupted = structuredClone(data)
    corrupted.questionnaires[0]!.linkedIds[0] = 'missing-task'
    expect(() => readTransfer(JSON.stringify(corrupted))).toThrow()
    const { management: _management, recovery: _recovery, ...version10 } = data
    const { questionnaires: _questionnaires, ...older } = version10
    const version9 = { ...version10, version: 9, tasks: data.tasks.map(({ purpose: _purpose, ...task }) => task) }
    expect(readTransfer(JSON.stringify(version9))).toEqual(version9)
    expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(version9))))).toEqual(version9)
    const version8 = { ...older, version: 8, tasks: older.tasks.map(({ purpose: _purpose, ...task }) => task) }
    expect(readTransfer(JSON.stringify(version8))).toEqual(version8)
    expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(version8))))).toEqual(version8)
  })
  it('retains unfinished responses and rejects stale or altered submitted snapshots on the PC', () => {
    const collector = new TransferCollector({ sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z',
      timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }, 5000)
    fixedTasks.forEach((task) => collector.updateTask(task))
    const book = new QuestionnaireBook()
    open(book, 'normal', 70000); book.answer('normal', 'q1', 4, 70003)
    const draft = book.snapshot()
    collector.updateQuestionnaires(draft)
    expect(readTransfer(writeTransfer(collector.export()))).toMatchObject({ questionnaires: [{ phase: 'answering', answers: { q1: 4 } }] })
    finish(book, 70010); collector.updateQuestionnaires(book.snapshot())
    expect(collector.updateQuestionnaires(draft)).toBe(false)
    const altered = book.snapshot(); altered[0]!.answers.q1 = 1
    expect(collector.updateQuestionnaires(altered)).toBe(false)
    expect(collector.surveyRuns[0]!.answers.q1).toBe(3)
  })
})

function renderSurvey(run: SurveyRun) {
  const noop = () => {}
  return renderToStaticMarkup(<QuestionnaireScreen run={run} onPresent={noop} onAnswer={noop} onSubmit={noop} />)
}
it('renders common and automatic items without preselecting answers; submitted screen hides the form', () => {
  const book = new QuestionnaireBook(); open(book, 'normal', 70000)
  const normal = renderSurvey(book.active!)
  expect(normal.match(/<fieldset/g)).toHaveLength(5)
  expect(normal).not.toContain('checked=""')
  expect(normal).not.toContain('表示の変化に気づかなかった')
  finish(book, 70010)
  expect(renderSurvey(book.active!)).toContain('回答を記録しました')
  expect(renderSurvey(book.active!)).not.toContain('<fieldset')
  open(book, 'automatic', 150000)
  const automatic = renderSurvey(book.active!)
  expect(automatic.match(/<fieldset/g)).toHaveLength(7)
  expect(automatic).toContain('表示の変化に気づかなかった／判断できない')
  expect(automatic).toContain('強く集中する必要があった。')
  const noop = () => {}
  const pc = renderToStaticMarkup(<QuestionnaireController runs={book.snapshot()} tasks={allTasks} disabled={false} onOpen={noop} />)
  expect(pc).toContain('回答中')
  expect(pc).toContain('回答済み・PC受信済み')
})
