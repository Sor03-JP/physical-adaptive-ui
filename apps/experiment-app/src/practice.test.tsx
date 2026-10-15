import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { canStartPractice, TransitTrial, transitTasks, targetTrainIndex, taskRunSchema } from './tasks'
import { QuestionnaireBook, conditionTaskIds } from './questionnaire'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import TransitTaskScreen from './TransitTaskScreen'

function render(trial: TransitTrial) {
  const noop = () => {}
  return renderToStaticMarkup(<TransitTaskScreen run={trial.snapshot()} onPresent={noop} onAdvance={noop}
    onSelectTrain={noop} onAnswer={noop} onTap={noop} onStop={noop}
    onPracticeBegin={noop} onPracticeConfirm={noop} onPracticeFinish={noop} />)
}
function completedPractice(id = 'practice') {
  const trial = new TransitTrial(id, 'session', 'P1', 0, 'automatic')
  trial.present(10); trial.begin(20); trial.present(30)
  trial.select(0, 40); trial.select(2, 50); trial.present(60)
  trial.advance(15030); trial.confirmStopped(15040); trial.present(15050); trial.answer('09:26', 15060)
  return trial
}

it('uses different stations, scenario time and train times from all main tasks', () => {
  const practice = transitTasks.P1
  expect(practice.now).toBe('09:05')
  expect(practice.trains[targetTrainIndex(practice)]).toMatchObject({ departure: '09:12', arrival: '09:26' })
  const stations = [practice.from, practice.to, ...practice.trains.map((train) => train.destination)]
  const times = [practice.now, ...practice.trains.flatMap((train) => [train.departure, train.arrival])]
  for (const [id, main] of Object.entries(transitTasks)) {
    if (id === 'P1') continue
    for (const station of [main.from, main.to, ...main.trains.map((train) => train.destination)]) expect(stations).not.toContain(station)
    for (const time of [main.now, ...main.trains.flatMap((train) => [train.departure, train.arrival])]) expect(times).not.toContain(time)
  }
})

it('offers phone controls only during practice and retains the same timed task flow', () => {
  const practice = new TransitTrial('practice', 'session', 'P1', 0, 'automatic')
  expect(render(practice)).toContain('理解したので練習を開始')
  expect(render(practice)).toMatch(/disabled=""[^>]*>理解したので練習を開始/)
  practice.present(10); practice.begin(20); practice.present(30)
  expect(render(practice)).not.toContain('理解したので練習を開始')
  practice.advance(15029)
  expect(practice.snapshot().phase).toBe('viewing')
  practice.advance(15030)
  expect(render(practice)).toContain('立ち止まったので回答へ')
  practice.confirmStopped(15040); practice.present(15050)
  expect(render(practice)).toContain('回答送信')
  practice.answer('09:26', 15060)
  expect(render(practice)).toContain('練習を閉じる')
  expect(practice.snapshot()).toMatchObject({ taskId: 'P1', purpose: 'practice', mode: 'automatic', outcome: 'correct' })
  expect(taskRunSchema.parse(practice.snapshot())).toEqual(practice.snapshot())
  const main = new TransitTrial('main', 'session', 'A1', 30000)
  expect(main.snapshot().purpose).toBe('main')
  expect(render(main)).not.toContain('理解したので練習を開始')
  main.present(30001); main.begin(30002); main.present(30003); main.advance(50003)
  expect(render(main)).not.toContain('立ち止まったので回答へ')
  expect(() => taskRunSchema.parse({ ...practice.snapshot(), purpose: 'main' })).toThrow()
  expect(() => taskRunSchema.parse({ ...main.snapshot(), purpose: 'practice' })).toThrow()
})

it('permits practice before main tasks only and never counts it towards a condition questionnaire', () => {
  const practice = completedPractice().snapshot()
  expect(canStartPractice(true, [], false)).toBe(true)
  expect(canStartPractice(false, [], false)).toBe(false)
  expect(canStartPractice(true, [practice], false)).toBe(true)
  expect(canStartPractice(true, [{ ...practice, phase: 'viewing' }], false)).toBe(false)
  expect(canStartPractice(true, [{ ...practice, purpose: 'main' }], false)).toBe(false)
  expect(canStartPractice(true, [practice], true)).toBe(false)
  const practices = ['one', 'two', 'three'].map((id) => completedPractice(id).snapshot())
  expect(conditionTaskIds(practices, 'automatic')).toEqual([])
  expect(() => new QuestionnaireBook().open('auto-survey', 'session', 'automatic', ['one', 'two', 'three'], 21000, practices)).toThrow()
})

it('preserves practice and main labels in JSON and reads version 9 without adding fields', () => {
  const collector = new TransferCollector({ sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z',
    timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }, 5000)
  collector.updateTask(completedPractice().snapshot())
  const main = new TransitTrial('main', 'session', 'A1', 30000)
  collector.updateTask(main.snapshot())
  const data = collector.export()
  expect(data.version).toBe(10)
  expect(data.tasks.map((task) => task.purpose)).toEqual(['practice', 'main'])
  expect(readTransfer(writeTransfer(data))).toEqual(data)
  const { purpose: _purpose, ...previousMain } = main.snapshot()
  const version10 = data
  const previous = { ...version10, version: 9, tasks: [previousMain] }
  expect(readTransfer(JSON.stringify(previous))).toEqual(previous)
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(previous))))).toEqual(previous)
})
