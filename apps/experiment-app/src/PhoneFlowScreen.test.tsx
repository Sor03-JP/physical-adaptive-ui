import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PhoneFlowScreen from './PhoneFlowScreen'
import { createPhoneFlow } from './phone-flow'

const noop = () => {}
const props = { flow: createPhoneFlow('session'), step: null, tasks: [], participantId: 'test01', connected: true,
  interrupted: false, recovered: false, stopped: false, pending: false, error: '', transferState: '', audioControls: null, sensorReady: true,
  onPrepare: noop, onAccept: noop, onTutorialNext: noop, onPractice: noop, onPracticeComplete: noop, onNext: noop,
  onReconnect: noop, onResume: noop, onRestart: noop, onConfirmMovement: noop }

it('requires explicit consent and allows preparation to continue after reconnection', () => {
  const consent = renderToStaticMarkup(<PhoneFlowScreen {...props} />)
  expect(consent).toContain('type="checkbox"')
  expect(consent).not.toContain('checked=""')
  expect(consent).toContain('disabled="">同意してチュートリアルへ')
  expect(consent).toContain('すぐに実験者に伝えてください')
  expect(consent).not.toContain('>実験を中止</button>')
  const offline = renderToStaticMarkup(<PhoneFlowScreen {...props} interrupted connected={false} />)
  expect(offline).toContain('disabled="">続きから始める')
  expect(offline).toContain('disabled="">最初からやる（リセット）')
  const reconnected = renderToStaticMarkup(<PhoneFlowScreen {...props} interrupted />)
  expect(reconnected).not.toContain('disabled="">続きから始める')
})

it('shows the result of reconnecting and leaves the stopped experiment under PC control', () => {
  const offline = renderToStaticMarkup(<PhoneFlowScreen {...props} stopped connected={false} />)
  expect(offline).toContain('PCに再接続する')
  expect(offline).toContain('PCとの接続を待っています')
  const connected = renderToStaticMarkup(<PhoneFlowScreen {...props} stopped />)
  expect(connected).toContain('PCとの接続を確認できました')
  expect(connected).not.toContain('PCに再接続する')
  expect(connected).not.toContain('最初からやり直す')
  expect(connected).not.toContain('続きから始める')
  expect(renderToStaticMarkup(<PhoneFlowScreen {...props} resuming />)).toContain('同意して実験の続きへ')

  const mismatch = renderToStaticMarkup(<PhoneFlowScreen {...props} stopped transferState="mismatch"
    flow={{ ...props.flow, stage: 'transfer', syncedAtMs: 1, consentedAtMs: 2 }} />)
  expect(mismatch).toContain('PCとiPhoneの内容が一致しません')
  expect(mismatch).toContain('再接続して転送を確認')
  expect(mismatch).not.toContain('記録を残して最初からやり直す')
  expect(mismatch).not.toContain('転送・内容確認が完了しました')
})

it('offers the video on the instructions page without requiring playback to continue', () => {
  const flow = { ...props.flow, stage: 'tutorial' as const, syncedAtMs: 1, consentedAtMs: 2 }
  const instructions = renderToStaticMarkup(<PhoneFlowScreen {...props} flow={flow} />)
  expect(instructions).toContain('<details class="tutorial-demo">')
  expect(instructions).toMatch(/<video[^>]+transit-tutorial\.mp4[^>]+controls=""[^>]+preload="none"/)
  expect(instructions).not.toContain('autoplay=""')
  expect(instructions).not.toContain('disabled="">操作方法を確認した')
  const practice = renderToStaticMarkup(<PhoneFlowScreen {...props} flow={{ ...flow, tutorialPage: 2 }} />)
  expect(practice).not.toContain('<video')
})
