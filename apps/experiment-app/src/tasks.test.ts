import { describe, expect, it } from 'vitest'
import { TransitTrial, taskRunSchema, transitTasks, targetTrainIndex } from './tasks'

function preparedTrial(...args: ConstructorParameters<typeof TransitTrial>) {
  const trial = new TransitTrial(...args)
  trial.present(args[3]); trial.begin(args[3])
  return trial
}
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import { messageSchema } from './protocol'

const metadata = { sessionId: 'session', startedAt: '2026-10-16T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 0, userAgent: 'test' }

describe('next-departure selection flow', () => {
  it('records wrong selections, first correct input and presentation, and the final selection separately', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.select(2, 50)
    expect(trial.snapshot()).toMatchObject({ startedAtMs: null, selectedTrainIndex: null, selectedAtMs: null })
    trial.present(100)
    trial.select(0, 200); trial.present(210) // departed
    trial.select(1, 300); trial.present(310) // another destination
    expect(trial.snapshot().selectedAtMs).toBeNull()
    trial.select(2, 400)
    expect(trial.snapshot()).toMatchObject({ selectedAtMs: 400, selectedShownAtMs: null })
    trial.present(420); trial.present(430)
    expect(trial.snapshot().selectedShownAtMs).toBe(420)
    expect(trial.snapshot().events.filter((e) => e.type === 'selection-shown')).toHaveLength(3)
    trial.select(4, 500); trial.present(510); trial.advance(20100) // later than the next eligible train
    expect(trial.snapshot()).toMatchObject({ phase: 'waiting-stop', hiddenAtMs: 20100,
      selectedTrainIndex: 4, selectedAtMs: 400, selectedShownAtMs: 420 })
    expect(trial.snapshot().events.find((e) => e.type === 'information-hidden')?.trainIndex).toBe(4)
    expect(trial.snapshot().events.filter((e) => e.type === 'train-selected').map((e) => e.trainIndex)).toEqual([0, 1, 2, 4])
    expect(taskRunSchema.parse(trial.snapshot())).toEqual(trial.snapshot())
  })

  it('does not restart the display deadline on changes and rejects input at the deadline', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0); trial.select(2, 14000); trial.present(14010)
    trial.select(1, 15000); trial.present(15001)
    expect(trial.snapshot()).toMatchObject({ phase: 'waiting-stop', hiddenAtMs: 15000, selectedTrainIndex: 2 })
    expect(trial.snapshot().events.filter((e) => e.type === 'train-selected')).toHaveLength(1)
  })

  it('does not count a target update as presented if its commit misses the deadline', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0); trial.select(2, 14999); trial.present(15000)
    expect(trial.snapshot()).toMatchObject({ selectedAtMs: 14999, selectedShownAtMs: null, phase: 'waiting-stop' })
  })

  it('rejects invalid candidate indexes and preserves repeated selections without resetting first success', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0)
    for (const index of [-1, 5, 1.5, NaN]) trial.select(index, 50)
    expect(trial.snapshot().selectedTrainIndex).toBeNull()
    trial.select(2, 100); trial.present(110); trial.select(2, 120)
    trial.select(1, 200); trial.present(210); trial.select(2, 300); trial.present(310)
    expect(trial.snapshot()).toMatchObject({ selectedAtMs: 100, selectedShownAtMs: 110, selectedTrainIndex: 2 })
    expect(trial.snapshot().events.filter((e) => e.type === 'train-selected')).toHaveLength(4)
  })

  it('requires stop confirmation and starts the answer timer at answer presentation', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0); trial.confirmStopped(100); trial.answer('10:48', 200)
    expect(trial.snapshot().phase).toBe('viewing')
    trial.advance(15000); trial.answer('10:48', 21000)
    expect(trial.snapshot().answer).toBeNull()
    trial.confirmStopped(22000); trial.confirmStopped(22010); trial.answer('10:48', 22020)
    expect(trial.snapshot().answer).toBeNull()
    trial.present(22100); trial.advance(32099)
    expect(trial.snapshot().phase).toBe('answering')
    trial.answer('10:48', 32100)
    expect(trial.snapshot()).toMatchObject({ phase: 'complete', outcome: 'unanswered', answer: null, endedAtMs: 32100 })
  })

  it.each([['10:48', 'correct'], ['10:38', 'incorrect'], ['unknown', 'unknown']] as const)(
    'keeps selection success independent from answer %s and preserves result %s', (answer, outcome) => {
      const trial = preparedTrial('one', 'session', 'A1', 0)
      trial.present(0); trial.advance(15000); trial.confirmStopped(21000); trial.present(21010); trial.answer(answer, 21500)
      expect(trial.snapshot()).toMatchObject({ phase: 'complete', selectedAtMs: null, answer, outcome })
      expect(taskRunSchema.parse(trial.snapshot())).toEqual(trial.snapshot())
      trial.answer('10:00', 21600)
      expect(trial.snapshot().answer).toBe(answer)
    },
  )

  it.each(['24:00', '10:60', '1048', '1:48', ''])('rejects invalid answer %s without consuming the answer', (answer) => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0); trial.advance(15000); trial.confirmStopped(21000); trial.present(21010); trial.answer(answer, 21500)
    expect(trial.snapshot()).toMatchObject({ phase: 'answering', answer: null })
  })

  it('records interruption and prevents subsequent presentation or answers', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0); trial.abort(1000, 'page-hidden'); trial.present(1100); trial.answer('10:48', 1200)
    expect(trial.snapshot()).toMatchObject({ phase: 'aborted', endedAtMs: 1000, abortReason: 'page-hidden', answer: null })
    expect(taskRunSchema.parse(trial.snapshot()).events.at(-1)?.type).toBe('aborted')
  })

  it('bounds interaction logs, isolates snapshots, and validates task commands and event times', () => {
    const trial = preparedTrial('one', 'session', 'A1', 0)
    trial.present(0)
    const snapshot = trial.snapshot()
    for (let t = 1; t <= 600; t++) trial.tap(t, 20, 30, 'outside')
    expect(snapshot.events).toHaveLength(3)
    expect(trial.snapshot()).toMatchObject({ phase: 'aborted', abortReason: 'event-capacity' })
    expect(taskRunSchema.parse(trial.snapshot()).events).toHaveLength(500)
    expect(taskRunSchema.safeParse({ ...snapshot, selectedAtMs: 20, selectedShownAtMs: 10 }).success).toBe(false)
    expect(messageSchema.safeParse({ type: 'task-start', sessionId: 'session', runId: 'one', taskId: 'A1' }).success).toBe(true)
    expect(messageSchema.safeParse({ type: 'task-start', sessionId: 'session', runId: 'one', taskId: 'A4' }).success).toBe(false)
  })

  it('derives the next train from fixed time and destination, with paired draft questions', () => {
    for (const task of Object.values(transitTasks)) {
      expect(task.trains).toHaveLength(5)
      const index = targetTrainIndex(task)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(task.trains[index].destination).toBe(task.to)
      expect(task.trains[index].departure > task.now).toBe(true)
      expect(task.trains.some((train) => train.departure < task.now)).toBe(true)
      expect(task.trains.some((train) => train.destination !== task.to)).toBe(true)
    }
    for (const number of [1, 2, 3] as const) {
      const a = transitTasks[`A${number}`], b = transitTasks[`B${number}`]
      expect(targetTrainIndex(a)).toBe(targetTrainIndex(b))
      expect(a.trains[targetTrainIndex(a)].arrival).not.toBe(b.trains[targetTrainIndex(b)].arrival)
    }
    expect(targetTrainIndex({ ...transitTasks.A1, now: '10:34' })).toBe(3)
    expect(targetTrainIndex({ ...transitTasks.A1, now: '10:50' })).toBe(-1)
    const snapshot = preparedTrial('one', 'session', 'A1', 0).snapshot()
    expect(taskRunSchema.safeParse({ ...snapshot, problem: { ...snapshot.problem, now: '10:50' } }).success).toBe(false)
  })
})

it('retains multiple selection tasks and all timestamps in PC JSON while preserving older file versions', () => {
  const collector = new TransferCollector(metadata, 5000)
  expect(collector.export().tasks).toEqual([])
  const first = preparedTrial('one', 'session', 'A1', 0)
  first.present(10); first.select(2, 200); first.present(210); first.advance(20010)
  first.confirmStopped(20100); first.present(20110); first.answer('10:48', 20200)
  expect(collector.updateTask(first.snapshot())).toBe(true)
  expect(collector.updateTask(first.snapshot())).toBe(false)
  const second = preparedTrial('two', 'session', 'A2', 21000)
  second.present(21010); collector.updateTask(second.snapshot())
  expect(collector.taskCount).toBe(2)
  const data = collector.export()
  expect(data.version).toBe(12)
  expect(readTransfer(writeTransfer(data))).toEqual(data)
  expect(data.tasks[0]).toMatchObject({ id: 'one', outcome: 'correct', selectedAtMs: 200, selectedShownAtMs: 210, answer: '10:48' })
  expect(data.tasks[1]).toMatchObject({ id: 'two', phase: 'viewing' })
  const { observationProtocol: _observationProtocol, management: _management, recovery: _recovery, tasks: _tasks, questionnaires: _questionnaires, research: _research, ...old } = data
  const { purpose: _purpose6, flow: _flow6, briefingShownAtMs: _briefing6, beginRequestedAtMs: _begin6, ...taskV6 } = first.snapshot()
  const version6 = { ...old, version: 6, tasks: [{ ...taskV6, events: taskV6.events.filter((event) => event.type !== 'briefing-shown' && event.type !== 'view-requested'),
    uiLog: taskV6.uiLog.filter((entry) => entry.phase !== 'briefing') }] }
  expect(readTransfer(JSON.stringify(version6))).toEqual(version6)
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(version6))))).toEqual(version6)

  const version7 = { ...old, version: 7, tasks: data.tasks.map(({ purpose: _purpose, ...task }) => task) }
  expect(readTransfer(JSON.stringify(version7))).toEqual(version7)
  const version3 = { ...old, version: 3 as const }
  expect(readTransfer(writeTransfer(version3))).toEqual(version3)
  // The earlier uncommitted prototype could already export platform-task files.
  const legacyTask = { id: 'old', sessionId: 'session', taskId: 'A1', mode: 'normal', phase: 'preparing',
    problem: { target: '青葉', routes: [1, 2, 3].map((platform) => ({ from: '青葉', to: '南町', departure: '10:24', platform })) },
    timing: { displayMs: 20000, answerMs: 10000 }, requestedAtMs: 0, startedAtMs: null, hiddenAtMs: null,
    stopConfirmedAtMs: null, answerShownAtMs: null, endedAtMs: null, selectedRoute: null, reachedAtMs: null,
    answer: null, outcome: null, abortReason: null, events: [] }
  const version4 = { ...old, version: 4, tasks: [legacyTask] }
  expect(readTransfer(JSON.stringify(version4))).toEqual(version4)
  const previous = { ...legacyTask, kind: 'next-train',
    problem: { from: '青葉', to: '南町', line: '青葉線', initialTrainIndex: 1, targetTrainIndex: 2,
      trains: [{ departure: '10:14', arrival: '10:28' }, { departure: '10:24', arrival: '10:38' }, { departure: '10:34', arrival: '10:48' }] },
    selectedTrainIndex: 1, changedAtMs: null, changedShownAtMs: null }
  const { selectedRoute: _selectedRoute, reachedAtMs: _reachedAtMs, ...previousTask } = previous
  const { purpose: _purpose5, uiConfig: _uiConfig, uiDecision: _uiDecision, uiLog: _uiLog, flow: _flow, briefingShownAtMs: _briefing, beginRequestedAtMs: _begin, ...selectionTaskV5 } = first.snapshot()
  const selectionVersion5 = { ...old, version: 5, tasks: [{ ...selectionTaskV5, events: selectionTaskV5.events.filter((event) => event.type !== 'briefing-shown' && event.type !== 'view-requested') }] }
  expect(readTransfer(JSON.stringify(selectionVersion5))).toEqual(selectionVersion5)
  const previousVersion5 = { ...old, version: 5, tasks: [previousTask] }
  expect(readTransfer(JSON.stringify(previousVersion5))).toEqual(previousVersion5)
  expect(JSON.parse(writeTransfer(readTransfer(JSON.stringify(previousVersion5))))).toEqual(previousVersion5)

})

describe('briefing before timed candidate display', () => {
  it('waits indefinitely for understanding and a PC start, then times from candidate presentation', () => {
    const trial = new TransitTrial('brief', 'session', 'A1', 0, 'automatic')
    trial.begin(1) // The problem has not actually appeared yet.
    expect(trial.snapshot().phase).toBe('briefing')
    trial.present(100)
    trial.select(2, 1000); trial.answer('10:48', 2000)
    trial.advance(60000); trial.present(60000)
    expect(trial.snapshot()).toMatchObject({ phase: 'briefing', briefingShownAtMs: 100, startedAtMs: null,
      beginRequestedAtMs: null, selectedTrainIndex: null, answer: null })
    trial.begin(61000); trial.begin(61010)
    expect(trial.snapshot()).toMatchObject({ phase: 'preparing', beginRequestedAtMs: 61000, startedAtMs: null })
    trial.select(2, 61020) // Candidate screen still has not committed.
    expect(trial.snapshot().selectedTrainIndex).toBeNull()
    trial.present(61500)
    trial.advance(76499)
    expect(trial.snapshot().phase).toBe('viewing')
    trial.advance(76500)
    expect(trial.snapshot()).toMatchObject({ phase: 'waiting-stop', hiddenAtMs: 76500, startedAtMs: 61500 })
    expect(trial.snapshot().events.filter((event) => ['briefing-shown', 'view-requested', 'task-shown'].includes(event.type)))
      .toMatchObject([{ type: 'briefing-shown', atMs: 100 }, { type: 'view-requested', atMs: 61000 }, { type: 'task-shown', atMs: 61500 }])
    expect(taskRunSchema.parse(trial.snapshot())).toEqual(trial.snapshot())
  })

  it('preserves interruption during briefing and rejects inconsistent preparation timestamps', () => {
    const trial = new TransitTrial('brief', 'session', 'A1', 0)
    trial.present(10); trial.abort(20, 'manual'); trial.begin(30); trial.present(40)
    expect(trial.snapshot()).toMatchObject({ phase: 'aborted', startedAtMs: null, beginRequestedAtMs: null })
    expect(taskRunSchema.parse(trial.snapshot())).toEqual(trial.snapshot())
    expect(taskRunSchema.safeParse({ ...trial.snapshot(), beginRequestedAtMs: 5 }).success).toBe(false)
    expect(messageSchema.safeParse({ type: 'task-begin', sessionId: 'session', runId: 'brief' }).success).toBe(true)
  })
})
