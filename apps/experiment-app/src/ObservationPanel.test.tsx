import { expect, it, vi } from 'vitest'
import { observationKey } from './ObservationPanel'

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
