import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import PhonePreparation from './PhonePreparation'

const base = { connected: true, storageReady: true, storageError: '', sensorReady: false, pending: false,
  recording: false, stopped: false, recovered: false, practiceReady: false, practiceFinished: false,
  onEnable: () => {}, onPractice: () => {} }
function render(overrides: Partial<typeof base> = {}) {
  return renderToStaticMarkup(<PhonePreparation {...base} {...overrides} />)
}
function buttons(html: string) { return [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map((match) => match[1]) }

it('offers permission only after connection and storage are ready, then waits for PC start', () => {
  for (const overrides of [{ connected: false }, { storageReady: false }, { storageError: '保存エラー' }]) {
    expect(buttons(render(overrides))).toEqual([])
  }
  expect(buttons(render())).toEqual(['センサー利用を許可・準備'])
  expect(render({ pending: true })).toMatch(/disabled=""/)
  const ready = render({ sensorReady: true })
  expect(ready).toContain('実験者がPCで記録を開始')
  expect(buttons(ready)).toEqual([])
})

it('offers one practice action and waits after practice, stop or recovery', () => {
  expect(buttons(render({ recording: true, practiceReady: true }))).toEqual(['練習問題を表示'])
  const after = render({ recording: true, practiceReady: true, practiceFinished: true })
  expect(after).toContain('練習が終わりました')
  expect(buttons(after)).toEqual([])
  expect(render({ stopped: true })).toContain('記録を終了しました')
  expect(buttons(render({ stopped: true }))).toEqual([])
  expect(render({ recovered: true })).toContain('更新前の記録を復旧しました')
  expect(buttons(render({ recovered: true, recording: true, practiceReady: true }))).toEqual([])
})
