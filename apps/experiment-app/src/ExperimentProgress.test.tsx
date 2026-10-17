import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ExperimentProgress, { experimentProgress } from './ExperimentProgress'
import TaskController from './TaskController'
import QuestionnaireController from './QuestionnaireController'
import Controller from './Controller'
import { TransitTrial } from './tasks'
import { surveyRunSchema, surveyItems } from './questionnaire'
import { emptyManagement } from './management'
import ParticipantManager from './ParticipantManager'

const participant = { participantId: 'p01', group: 'G4' as const, rosterId: 'roster' }
const base = { recording: true, active: true, recovery: false, participant, step: null, run: null }
const noop = () => {}
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map((match) => match[1]!.replace(/<[^>]*>/g, ''))
function trial() { return new TransitTrial('trial', 'session', 'A1', 0, 'automatic') }
function taskHtml(t: TransitTrial, pending = false) {
  return renderToStaticMarkup(<TaskController planned={{ taskId: 'A1', mode: 'automatic' }} startAllowed
    run={t.snapshot()} count={1} elapsedSeconds={5} disabled={false} pending={pending} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
}

describe('controller experiment flow', () => {
  it('uses the assigned condition order and distinguishes practice, comparison, stop and recovery', () => {
    expect(experimentProgress({ ...base, recording: false }).index).toBe(0)
    expect(experimentProgress({ ...base, step: { kind: 'practice' } }).index).toBe(1)
    const practice = new TransitTrial('practice', 'session', 'P1', 0, 'automatic').snapshot()
    expect(experimentProgress({ ...base, step: { kind: 'active', runId: practice.id }, run: practice }).index).toBe(1)
    expect(experimentProgress({ ...base, step: { kind: 'task', taskId: 'A1', mode: 'automatic' } })).toEqual({ index: 2, title: '第1条件・課題1／3' })
    expect(experimentProgress({ ...base, step: { kind: 'survey', target: 'automatic' } })).toEqual({ index: 2, title: '第1条件・アンケート' })
    expect(experimentProgress({ ...base, step: { kind: 'task', taskId: 'B2', mode: 'normal' } })).toEqual({ index: 3, title: '第2条件・課題2／3' })
    expect(experimentProgress({ ...base, step: { kind: 'survey', target: 'final' } }).index).toBe(4)
    expect(experimentProgress({ ...base, step: { kind: 'done' } })).toEqual({ index: 5, title: '全課題終了・記録を停止' })
    expect(experimentProgress({ ...base, active: false }).title).toBe('記録を保存して確認')
    expect(experimentProgress({ ...base, recovery: true }).title).toBe('中断した記録を回収・保存')
    const html = renderToStaticMarkup(<ExperimentProgress index={3} />)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toContain('aria-current="step"><span>4</span>第2条件')
  })
  it('shows only the task action appropriate to briefing, viewing, stop-wait and answering', () => {
    const t = trial()
    expect(buttons(taskHtml(t))).toEqual(['理解・開始状態を確認して計測開始'])
    expect(taskHtml(t)).toMatch(/disabled=""[^>]*>理解・開始状態/)
    t.present(1)
    expect(taskHtml(t)).not.toMatch(/disabled=""[^>]*>理解・開始状態/)
    expect(taskHtml(t, true)).toMatch(/disabled=""[^>]*>理解・開始状態/)
    t.begin(2); t.present(3)
    expect(buttons(taskHtml(t))).toEqual([])
    expect(taskHtml(t)).toContain('5.0')
    t.advance(15003)
    expect(buttons(taskHtml(t))).toEqual(['静止を確認して回答画面へ'])
    t.confirmStopped(15004); t.present(15005)
    expect(buttons(taskHtml(t))).toEqual([])
    expect(taskHtml(t)).toContain('iPhoneで回答中')
    t.answer('unknown', 15006)
    expect(buttons(taskHtml(t))).toEqual(['問題文を表示'])
    expect(taskHtml(t)).not.toContain('目標の電車')
    const next = renderToStaticMarkup(<TaskController planned={{ taskId: 'B2', mode: 'normal' }} startAllowed
      run={t.snapshot()} count={1} elapsedSeconds={0} disabled={false} pending={false} onStart={noop} onBegin={noop} onConfirmStopped={noop} />)
    expect(next).toContain('固定UI・B2')
    expect(next).not.toContain('自動適応UI・A1')
  })
  it('offers one survey action, then displays waiting status without exposing answers', () => {
    const props = { allowedTarget: 'automatic' as const, tasks: [], disabled: false, onOpen: noop }
    const before = renderToStaticMarkup(<QuestionnaireController {...props} runs={[]} />)
    expect(buttons(before)).toEqual(['静止を確認してアンケートを表示'])
    expect(before).toMatch(/disabled=""/)
    const survey = surveyRunSchema.parse({ id: 'survey', sessionId: 'session', target: 'automatic', instrumentVersion: 1,
      linkedIds: ['task1', 'task2', 'task3'], items: surveyItems('automatic'), phase: 'answering', requestedAtMs: 1,
      shownAtMs: 2, updatedAtMs: 3, submittedAtMs: null, answers: { q1: 5 } })
    const during = renderToStaticMarkup(<QuestionnaireController {...props} runs={[survey]} />)
    expect(buttons(during)).toEqual([])
    expect(during).toContain('1／7項目入力')
    expect(during).not.toContain('必要な乗換情報を見つけやすかった')
  })
  it('separates participant setup from retry controls and renders one start action initially', () => {
    const setup = renderToStaticMarkup(<ParticipantManager variant="setup" participant={null} selected={participant} onSelect={noop} locked={false}
      management={emptyManagement()} tasks={[]} surveys={[]} pending={false} onFailure={noop} onRetry={noop} jsonExported={false} csvExported={false} verified={false} />)
    expect(setup).toContain('参加者ID')
    expect(setup).not.toContain('同じ課題を1回再実施')
    const html = renderToStaticMarkup(<Controller identity={{ room: 'flow-review', role: 'controller' }} />)
    expect(buttons(html).filter((label) => label === '記録を開始して練習へ')).toHaveLength(1)
    expect(html).toContain('詳細・トラブル対応')
    expect(html).not.toContain('問題文を表示</button>')
  })
})
