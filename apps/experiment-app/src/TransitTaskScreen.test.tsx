import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import TransitTaskScreen from './TransitTaskScreen'
import TaskController from './TaskController'
import { TransitTrial } from './tasks'

function preparedTrial(...args: ConstructorParameters<typeof TransitTrial>) {
  const trial = new TransitTrial(...args)
  trial.present(args[3]); trial.begin(args[3])
  return trial
}

function render(trial: TransitTrial) {
  const noop = () => {}
  return renderToStaticMarkup(<TransitTaskScreen run={trial.snapshot()} onPresent={noop} onAdvance={noop}
    onSelectTrain={noop} onAnswer={noop} onTap={noop} onStop={noop} />)
}

it('shows the fixed scenario time, departure, destination, and five equally selectable candidates', () => {
  const trial = preparedTrial('one', 'session', 'A1', 0)
  trial.present(0)
  const initial = render(trial)
  expect(initial).toContain('想定現在時刻')
  for (const text of ['10:25', '青葉', '南町', '北浜', '10:24', '10:28', '10:34', '10:40', '10:46', '10:48']) expect(initial).toContain(text)
  expect(initial.match(/data-task-action="train-\d"/g)).toHaveLength(5)
  expect(initial).not.toContain('1本後')
  expect(initial).not.toContain('乗り場')
  expect(initial).not.toContain('aria-pressed="true"')
  trial.select(1, 100); trial.present(110)
  const wrong = render(trial)
  expect(wrong).toMatch(/aria-pressed="true" data-task-action="train-1"/)
  expect(wrong).not.toContain('不正解')
  trial.select(2, 200); trial.present(210)
  const correct = render(trial)
  expect(correct).toMatch(/aria-pressed="true" data-task-action="train-2"/)
  expect(correct).not.toContain('正解')
})

it('hides station, scenario time, timetable and previous selection while waiting and answering', () => {
  const trial = preparedTrial('one', 'session', 'A1', 0)
  trial.present(0); trial.select(2, 100); trial.present(101); trial.advance(20000)
  const checkHidden = () => {
    const html = render(trial)
    for (const text of ['青葉', '南町', '10:25', '10:24', '10:34', '10:38', '10:48', 'train-2']) expect(html).not.toContain(text)
  }
  checkHidden()
  trial.confirmStopped(21000); trial.present(21001); checkHidden()
  expect(render(trial)).toContain('回答送信')
  expect(render(trial)).toContain('4桁')
  expect(render(trial)).toContain('answer-0')
  expect(render(trial)).toContain('分からない')
  expect(render(trial)).toMatch(/disabled=""[^>]*>回答送信/)
  trial.answer('10:48', 21500); checkHidden()
  expect(render(trial)).not.toContain('correct')
})

it('preserves selection and independent answer logs while PC controls focus on the current task stage', () => {
  const trial = preparedTrial('one', 'session', 'A1', 0)
  const noop = () => {}
  const pc = () => renderToStaticMarkup(<TaskController run={trial.snapshot()} count={1} elapsedSeconds={0}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(trial.snapshot().selectedTrainIndex).toBeNull()
  expect(pc()).toContain('候補表示準備中')
  trial.present(0); trial.select(0, 100); trial.present(110); trial.select(1, 200); trial.present(210)
  expect(trial.snapshot().events.filter((event) => event.type === 'train-selected').map((event) => event.trainIndex)).toEqual([0, 1])
  expect(pc()).toContain('情報表示中')
  expect(pc()).not.toContain('北浜行き')
  trial.advance(20000); trial.confirmStopped(21000); trial.present(21001); trial.answer('10:48', 21500)
  expect(trial.snapshot()).toMatchObject({ outcome: 'correct', selectedAtMs: null, selectedTrainIndex: 1 })
  expect(pc()).toContain('問題文を表示')
})

it('adapts only typography and touch regions while preserving candidates, order, and selection', () => {
  const normal = preparedTrial('fixed', 'session', 'A1', 0, 'normal')
  const automatic = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  for (const trial of [normal, automatic]) {
    trial.present(0); trial.select(1, 1)
    trial.updateAdaptation({ evaluatedAtMs: 2, stabilizedAtMs: 2, stabilizedState: 'running' }, 3)
    trial.present(4)
  }
  const fixedHtml = render(normal), autoHtml = render(automatic)
  expect(fixedHtml).toContain('data-physical-state="stationary"')
  expect(fixedHtml).toContain('--task-row-height:56px;--task-row-font:16px')
  expect(autoHtml).toContain('data-physical-state="running"')
  expect(autoHtml).toContain('--task-row-height:72px;--task-row-font:24px')
  expect(fixedHtml.replace(/data-physical-state="[^"]*"|style="[^"]*"/g, '')).toBe(autoHtml.replace(/data-physical-state="[^"]*"|style="[^"]*"/g, ''))
})

it('uses identical waiting and answer screens in fixed and automatic conditions', () => {
  const normal = preparedTrial('fixed', 'session', 'A1', 0, 'normal')
  const automatic = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  for (const trial of [normal, automatic]) {
    trial.present(0); trial.updateAdaptation({ evaluatedAtMs: 1, stabilizedAtMs: 1, stabilizedState: 'running' }, 2)
    trial.advance(20000)
  }
  expect(render(normal)).toBe(render(automatic))
  for (const trial of [normal, automatic]) { trial.confirmStopped(21000); trial.present(21001) }
  expect(render(normal)).toBe(render(automatic))
})

it('shows only the problem before PC start, and retains the same problem with candidates afterwards', () => {
  const trial = new TransitTrial('brief', 'session', 'A1', 0, 'automatic')
  trial.updateAdaptation({ evaluatedAtMs: 0, stabilizedAtMs: 0, stabilizedState: 'running' }, 1)
  trial.present(10)
  const briefing = render(trial)
  for (const text of ['南町行きで次に発車する電車', '想定現在時刻', '10:25', '青葉', '目的地']) expect(briefing).toContain(text)
  for (const text of ['train-2', '10:34', '10:48', '北浜']) expect(briefing).not.toContain(text)
  expect(briefing).toContain('data-physical-state="stationary"')
  expect(briefing).toContain('実験者にお知らせください')
  const noop = () => {}
  const controller = renderToStaticMarkup(<TaskController run={trial.snapshot()} count={1} elapsedSeconds={0}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(controller).not.toContain('>問題文を表示</button>')
  expect(controller).toContain('理解・開始状態を確認して計測開始')
  trial.begin(100); trial.present(110)
  const candidates = render(trial)
  expect(candidates).toContain('南町行きで次に発車する電車')
  expect(candidates).toContain('10:25')
  expect(candidates.match(/data-task-action="train-\d"/g)).toHaveLength(5)
  expect(candidates).toContain('data-physical-state="running"')
})

it('hides inferred and applied states from the PC observer while retaining task controls', () => {
  const trial = preparedTrial('observer', 'session', 'A1', 0, 'automatic')
  trial.present(0)
  trial.updateAdaptation({ evaluatedAtMs: 1, stabilizedAtMs: 1, stabilizedState: 'running' }, 2)
  trial.present(3)
  const noop = () => {}
  const html = renderToStaticMarkup(<TaskController run={trial.snapshot()} count={1} elapsedSeconds={0}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(html).not.toContain('UIへ反映した状態：')
  expect(html).not.toContain('安定化後の入力：')
  expect(html).toContain('情報表示中')
  expect(html).not.toContain('静止を確認して回答画面へ')
  trial.advance(15000)
  const stopped = renderToStaticMarkup(<TaskController run={trial.snapshot()} count={1} elapsedSeconds={15}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(stopped).toContain('静止を確認して回答画面へ')
})
