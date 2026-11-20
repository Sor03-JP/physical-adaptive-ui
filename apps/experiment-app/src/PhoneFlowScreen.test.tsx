import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PhoneFlowScreen from './PhoneFlowScreen'
import { createPhoneFlow } from './phone-flow'

it('requires explicit consent and presents resume/reset or retry/reset without silently restarting', () => {
  const noop = () => {}
  const props = { flow: createPhoneFlow('session'), step: null, tasks: [], participantId: 'test01', connected: true,
    interrupted: false, recovered: false, stopped: false, pending: false, error: '', transferState: '', audioControls: null, sensorReady: true,
    onPrepare: noop, onAccept: noop, onTutorialNext: noop, onPractice: noop, onPracticeComplete: noop, onNext: noop,
    onReconnect: noop, onResume: noop, onRestart: noop, onConfirmMovement: noop, onStop: noop }
  const consent = renderToStaticMarkup(<PhoneFlowScreen {...props} />)
  expect(consent).toContain('type="checkbox"')
  expect(consent).not.toContain('checked=""')
  expect(consent).toContain('disabled="">同意してチュートリアルへ')
  expect(consent).toContain('実験を中止')
  const offline = renderToStaticMarkup(<PhoneFlowScreen {...props} interrupted connected={false} />)
  expect(offline).toContain('disabled="">続きから始める')
  expect(offline).toContain('disabled="">最初からやる（リセット）')
  const reconnected = renderToStaticMarkup(<PhoneFlowScreen {...props} interrupted />)
  expect(reconnected).not.toContain('disabled="">続きから始める')
  const mismatch = renderToStaticMarkup(<PhoneFlowScreen {...props} stopped transferState="mismatch"
    flow={{ ...props.flow, stage: 'transfer', syncedAtMs: 1, consentedAtMs: 2 }} />)
  expect(mismatch).toContain('PCとiPhoneの内容が一致しません')
  expect(mismatch).toContain('再接続して転送を確認')
  expect(mismatch).toContain('記録を残して最初からやり直す')
  expect(mismatch).not.toContain('転送・内容確認が完了しました')
})
