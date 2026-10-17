import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ObservationPanel from './ObservationPanel'
import { ResearchRecorder } from './research-log'

const props = { log: null, run: null, elapsedMs: 0, busy: false, disabled: false, hidden: true, onHidden: () => {}, onCalibrate: () => {} }

it('leaves only calibration controls and directs movement confirmation to the end of the task', () => {
  const html = renderToStaticMarkup(<ObservationPanel {...props} />)
  const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)]
  expect(buttons).toHaveLength(1)
  expect(buttons[0]![2]).toContain('時刻合わせを再計測')
  expect(html).toContain('回答終了後に「予定どおり／ずれあり」を記録')
  const busy = renderToStaticMarkup(<ObservationPanel {...props} busy />)
  expect(busy).toMatch(/<button disabled="">時刻合わせ/)
  expect(busy).toContain('時刻合わせ中')
  const disabled = renderToStaticMarkup(<ObservationPanel {...props} disabled />)
  expect(disabled).toMatch(/<button disabled="">時刻合わせ/)
})

it('keeps historical instruction and observation events readable without editing them', () => {
  const recorder = new ResearchRecorder('session', 0)
  recorder.record({ kind: 'instruction', value: 'walking', controllerAtMs: 100, taskRunId: null, reportedPhase: null })
  recorder.record({ kind: 'observation', value: 'missed', controllerAtMs: 200, taskRunId: null, reportedPhase: null })
  const before = recorder.snapshot()
  const html = renderToStaticMarkup(<ObservationPanel {...props} log={before} />)
  expect(html).toContain('観察1件／指示1件')
  expect(html).toContain('指示：歩行を指示した'); expect(html).toContain('観察：見落とし・記録不能')
  expect(recorder.snapshot()).toEqual(before)
})
