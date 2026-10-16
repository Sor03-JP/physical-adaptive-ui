import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ObservationPanel, { canRecordObservation, observationKey } from './ObservationPanel'

it('allows observation through stopping and answering, but locks between tasks and during surveys', () => {
  for (const phase of ['briefing', 'preparing', 'viewing', 'waiting-stop', 'answering']) {
    expect(canRecordObservation(phase, false)).toBe(true)
    expect(canRecordObservation(phase, true)).toBe(false)
  }
  for (const phase of [null, 'complete', 'aborted']) expect(canRecordObservation(phase, false)).toBe(false)
  const noop = () => {}
  const html = renderToStaticMarkup(<ObservationPanel compact log={null} active={false} busy={false} disabled={false}
    hidden={true} onHidden={noop} onRecord={noop} onCalibrate={noop} />)
  const recordingButtons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].filter((match) => !match[2]!.includes('時刻合わせ'))
  expect(recordingButtons).toHaveLength(9)
  for (const match of recordingButtons) expect(match[1]).toContain('disabled=""')
  expect(html).toContain('次の問題文が表示されると')
})

it('records individual observation keys but ignores repeats, shortcuts and focused controls', () => {
  const event = { code: 'Space', repeat: false, ctrlKey: false, metaKey: false, altKey: false }
  expect(observationKey(event, null)).toBe('transition')
  for (const [code, kind] of [['Digit1', 'stationary'], ['Digit2', 'walking'], ['Digit3', 'running'], ['Digit4', 'uncertain']])
    expect(observationKey({ ...event, code: code! }, null)).toBe(kind)
  expect(observationKey({ ...event, repeat: true }, null)).toBeNull()
  expect(observationKey({ ...event, ctrlKey: true }, null)).toBeNull()
  expect(observationKey({ ...event, code: 'Enter' }, null)).toBeNull()
  class FocusTarget {
    isContentEditable = false
    constructor(readonly control: boolean) {}
    closest() { return this.control ? this : null }
  }
  vi.stubGlobal('HTMLElement', FocusTarget)
  try {
    expect(observationKey(event, new FocusTarget(true) as unknown as EventTarget)).toBeNull()
    expect(observationKey(event, new FocusTarget(false) as unknown as EventTarget)).toBe('transition')
  } finally { vi.unstubAllGlobals() }
})
