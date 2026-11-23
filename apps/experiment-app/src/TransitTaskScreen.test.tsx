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
  return renderToStaticMarkup(<TransitTaskScreen run={trial.snapshot()} onPresent={noop} onAdvance={noop} onShowDetails={noop}
    onSelectTrain={noop} onAnswer={noop} onTap={noop} onStop={noop} />)
}

it('shows scheduled times in the list, expected times in details, and marks explicitly chosen routes', () => {
  const trial = preparedTrial('one', 'session', 'A1', 0)
  trial.present(0)
  const initial = render(trial)
  expect(initial).toContain('想定現在時刻')
  for (const text of ['10:25', '青葉駅', '南町駅', '青葉線', '中央線', '白川線', '18分', '予定 10:27 発 → 10:45 着', '予定 10:31 発 → 10:46 着']) expect(initial).toContain(text)
  expect(initial).toContain('<span class="task-route-status" data-delayed="true">遅延</span>')
  expect(initial).toContain('<span class="task-route-status">定刻</span>')
  for (const text of ['10:29', '10:47', 'この便を選ぶ']) expect(initial).not.toContain(text)
  expect(initial.match(/data-task-action="route-open-\d"/g)).toHaveLength(3)
  trial.showDetails(0, 100); trial.present(110)
  const detail = render(trial)
  for (const text of ['発車見込み', '到着見込み', '10:29', '定刻 10:27・2分遅れ', '10:47', '定刻 10:45・2分遅れ', '18分', 'この便を選ぶ', '一覧に戻る']) expect(detail).toContain(text)
  expect(detail).not.toContain('10:46')
  expect(detail).not.toContain('選択済み')
  trial.select(0, 120); trial.present(130); trial.showDetails(null, 140)
  expect(render(trial)).toMatch(/data-selected="true" data-task-action="route-open-0"/)
  trial.showDetails(1, 200)
  expect(render(trial)).toContain('10:46')
  expect(render(trial)).not.toContain('分遅れ')
  trial.select(1, 210); trial.present(220); trial.showDetails(null, 230)
  const list = render(trial)
  expect(list).toMatch(/data-selected="true" data-task-action="route-open-1"/)
  expect(list).not.toContain('正解')
})

it('hides station, scenario time, timetable and previous selection while waiting and answering', () => {
  const trial = preparedTrial('one', 'session', 'A1', 0)
  trial.present(0); trial.showDetails(1, 90); trial.select(1, 100); trial.present(101); trial.advance(20000)
  const checkHidden = () => {
    const html = render(trial)
    for (const text of ['青葉', '南町', '中央線', '10:25', '10:45', '10:46', '10:47', 'route-open', 'route-select']) expect(html).not.toContain(text)
  }
  checkHidden()
  trial.confirmStopped(21000); trial.present(21001); checkHidden()
  expect(render(trial)).toContain('回答送信')
  expect(render(trial)).toContain('4桁')
  expect(render(trial)).toContain('answer-0')
  expect(render(trial)).toContain('分からない')
  expect(render(trial)).toMatch(/disabled=""[^>]*>回答送信/)
  trial.answer('10:46', 21500); checkHidden()
  expect(render(trial)).not.toContain('correct')
})

it('adapts only typography and touch regions while preserving candidates, order, and selection', () => {
  const normal = preparedTrial('fixed', 'session', 'A1', 0, 'normal')
  const automatic = preparedTrial('auto', 'session', 'A1', 0, 'automatic')
  for (const trial of [normal, automatic]) {
    trial.present(0)
    trial.updateAdaptation({ evaluatedAtMs: 2, stabilizedAtMs: 2, stabilizedState: 'running' }, 3)
    trial.present(4)
  }
  const fixedHtml = render(normal), autoHtml = render(automatic)
  expect(fixedHtml).toContain('data-physical-state="stationary"')
  expect(fixedHtml).toContain('--task-row-height:56px;--task-row-font:16px')
  expect(autoHtml).toContain('data-physical-state="running"')
  expect(autoHtml).toContain('--task-row-height:72px;--task-row-font:24px')
  expect(fixedHtml.replace(/data-physical-state="[^"]*"|style="[^"]*"/g, '')).toBe(autoHtml.replace(/data-physical-state="[^"]*"|style="[^"]*"/g, ''))
  for (const trial of [normal, automatic]) {
    trial.showDetails(1, 5); trial.select(1, 6); trial.present(7)
  }
  expect(render(normal).replace(/data-physical-state="[^"]*"|style="[^"]*"/g, '')).toBe(render(automatic).replace(/data-physical-state="[^"]*"|style="[^"]*"/g, ''))
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
  for (const text of ['南町駅に最も早く着く便', '一部の路線が遅延', '想定現在時刻', '10:25', '青葉', '目的地']) expect(briefing).toContain(text)
  for (const text of ['route-open', '10:29', '10:46', '中央線']) expect(briefing).not.toContain(text)
  expect(briefing).toContain('data-physical-state="stationary"')
  expect(briefing).toContain('18秒間、静止を維持')
  expect(briefing).toContain('実験者にお知らせください')
  const noop = () => {}
  const controller = renderToStaticMarkup(<TaskController planned={{ taskId: 'A1', mode: trial.snapshot().mode }} startAllowed run={trial.snapshot()} count={1} elapsedSeconds={0}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(controller).not.toContain('>問題文を表示</button>')
  expect(controller).toContain('理解・開始状態を確認して計測開始')
  trial.begin(100); trial.present(110)
  const candidates = render(trial)
  expect(candidates).toContain('南町駅に最も早く着く便')
  expect(candidates).toContain('10:25')
  expect(candidates).not.toContain('この課題の動作')
  expect(candidates.match(/data-task-action="route-open-\d"/g)).toHaveLength(3)
  expect(candidates).toContain('data-physical-state="running"')
})

it('shows the 4-second and 14-second movements only before a timed changing task', () => {
  for (const [id, description] of [
    ['A2', '静止で開始 → 4秒で歩行 → 14秒で停止'],
    ['A3', '歩行で開始 → 4秒で軽いジョギング → 14秒で歩行 → 18秒で停止'],
  ] as const) {
    const trial = new TransitTrial(id, 'session', id, 0)
    expect(render(trial)).toContain(description)
    trial.present(0); trial.begin(1); trial.present(2)
    expect(render(trial)).not.toContain(description)
  }
})

it('hides inferred and applied states from the PC observer while retaining task controls', () => {
  const trial = preparedTrial('observer', 'session', 'A1', 0, 'automatic')
  trial.present(0)
  trial.updateAdaptation({ evaluatedAtMs: 1, stabilizedAtMs: 1, stabilizedState: 'running' }, 2)
  trial.present(3)
  const noop = () => {}
  const html = renderToStaticMarkup(<TaskController planned={{ taskId: 'A1', mode: trial.snapshot().mode }} startAllowed run={trial.snapshot()} count={1} elapsedSeconds={0}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(html).not.toContain('UIへ反映した状態：')
  expect(html).not.toContain('安定化後の入力：')
  expect(html).toContain('情報表示中')
  expect(html).not.toContain('静止を確認して回答画面へ')
  trial.advance(18000)
  const stopped = renderToStaticMarkup(<TaskController planned={{ taskId: 'A1', mode: trial.snapshot().mode }} startAllowed run={trial.snapshot()} count={1} elapsedSeconds={15}
    disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
  expect(stopped).toContain('静止を確認して回答画面へ')
})
