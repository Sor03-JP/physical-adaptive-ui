import { useEffect, useState } from 'react'
import { assignments, createRoster, rosterSchema, nextStep, failureCategorySchema, failureLabels } from './management'
import type { Participant, Management, Failure, Roster } from './management'
import type { TaskRun } from './task-schema'
import type { SurveyRun } from './questionnaire'
import { readSetting, getOrCreateSetting } from './checkpoint'
import { downloadText } from './download'

export default function ParticipantManager({ participant, selected, onSelect, locked, management, tasks, retryTasks, surveys, pending, retryDisabled, onFailure, onRetry, csvExported, verified, variant }: {
  variant: 'setup' | 'details'
  participant: Participant | null; selected: Participant | null; onSelect: (p: Participant | null) => void
  locked: boolean; management: Management; tasks: TaskRun[]; retryTasks: TaskRun[]; surveys: SurveyRun[]; pending: boolean; retryDisabled: boolean
  onFailure: (failure: Omit<Failure, 'recordedAtControllerMs'>) => void; onRetry: (originalRunId: string) => void
  csvExported: boolean; verified: boolean
}) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [error, setError] = useState('')
  const [originalId, setOriginalId] = useState('')
  const [category, setCategory] = useState<Failure['category']>('task-not-shown')
  const [reason, setReason] = useState('')
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    let live = true
    void readSetting('participant-roster').then((data) => { if (live && data) setRoster(rosterSchema.parse(data)) })
      .catch(() => { if (live) setError('割当表を読み込めません。保存領域を確認してください。') })
    return () => { live = false }
  }, [])
  async function generateRoster() {
    try {
      // A second tab must reuse the existing roster, never silently reshuffle it.
      const value = rosterSchema.parse(await getOrCreateSetting('participant-roster', () => createRoster(crypto.randomUUID(), new Date().toISOString())))
      setRoster(value); setError('')
    } catch { setError('割当表を保存できませんでした。開始前に解消してください。') }
  }
  const current = participant ?? selected
  const step = current ? nextStep(current, tasks, surveys, management) : null
  const original = retryTasks.find((t) => t.id === originalId)
  const recorded = management.failures.find((f) => f.originalRunId === originalId)
  const retryIntent = management.retries.find((r) => r.originalRunId === originalId)
  const retried = management.retries.some((r) => r.retryRunId === originalId) || (retryIntent !== undefined && tasks.some((t) => t.id === retryIntent.retryRunId))
  const describe = (mode: 'normal' | 'automatic', set: string) => `${mode === 'normal' ? '固定UI' : '自動適応UI'}・${set}`
  return <section>
    <h2>{variant === 'setup' ? '参加者を選択' : '参加者・実験の進行管理'}</h2>
    {variant === 'setup' && <>
    <p>開始前に参加者IDを選びます。氏名は記録しません。割当は保存後に固定し、人数が10名以外の場合は割当方針を再確認してください。</p>
    {!roster && <button disabled={locked} onClick={() => void generateRoster()}>10名分の割当表を作成・保存</button>}
    <label>参加者ID <select disabled={locked} value={current?.participantId ?? ''} onChange={(event) => {
      const id = event.currentTarget.value
      onSelect(id === 'test01' ? { participantId: id, group: 'G1', rosterId: 'rehearsal' } : roster?.entries.find((p) => p.participantId === id) ?? null)
    }}><option value="">選択してください</option><option value="test01">test01（動作確認用）</option>
      {roster?.entries.map((entry) => <option key={entry.participantId} value={entry.participantId}>{entry.participantId} ／ {entry.group}</option>)}
    </select></label>
    </>}
    {roster && <details><summary>保存済みの割当表</summary><ol>{roster.entries.map((p) => <li key={p.participantId}>{p.participantId}：{assignments[p.group].map((b) => describe(b.mode, b.set)).join(' → ')}</li>)}</ol>
      <button onClick={() => downloadText(JSON.stringify(roster, null, 2), `participant-roster-${roster.id}.json`, 'application/json')}>割当表をJSON出力</button>
    </details>}
    {error && <p className="error">{error}</p>}
    {current && <p>参加者：{current.participantId} ／ {assignments[current.group].map((b) => describe(b.mode, b.set)).join(' → ')}</p>}
    {variant === 'details' && <>
    {current && <>
      <p className="status">次の操作：{step?.kind === 'practice' ? 'iPhoneで共通練習を実施' : step?.kind === 'active' ? '現在の課題を進行' : step?.kind === 'task' ? `${describe(step.mode, step.taskId[0]!)}・${step.taskId}の問題文を表示`
        : step?.kind === 'survey' ? step.target === 'final' ? '最後の比較・自由回答' : `${step.target === 'normal' ? '固定UI' : '自動適応UI'}後のアンケート` : '記録停止・データ保存・保存ファイルの確認'}</p>
      <ol><li>練習：{tasks.some((t) => t.purpose === 'practice' && t.phase === 'complete') ? '終了' : '未終了'}</li>
        {assignments[current.group].map((block) => <li key={block.mode}>{describe(block.mode, block.set)}：
          {[1, 2, 3].map((n) => `${block.set}${n} ${tasks.some((t) => t.taskId === `${block.set}${n}` && t.mode === block.mode && t.phase === 'complete' && !management.failures.some((f) => f.originalRunId === t.id)) ? '終了' : '未終了'}`).join(' ／ ')}
          、アンケート {surveys.some((s) => s.target === block.mode && s.phase === 'submitted') ? '回答済み' : '未完了'}</li>)}
        <li>最後の比較：{surveys.some((s) => s.target === 'final' && s.phase === 'submitted') ? '回答済み' : '未完了'}</li>
      </ol></>}
    <p>保存の進み具合：アンケート表のダウンロード操作 {csvExported ? '済' : '未'} ／ 保存ファイルの一致 {verified ? '確認済み' : '未確認'}</p>
    <details data-retry-panel><summary>技術的不成立・再実施（元の記録を保持）</summary>
      <p>誤判定・unknown・誤答・観察漏れは再実施の理由にしません。技術的不成立のみ、原因解消と本人の同意後に元課題につき1回までです。</p>
      <label>元の課題 <select value={originalId} onChange={(event) => { setOriginalId(event.currentTarget.value); setConsent(false); setReason('') }}>
        <option value="">選択してください</option>{retryTasks.filter((t) => t.purpose === 'main').map((t) => <option key={t.id} value={t.id}>{t.taskId} ／ {t.mode} ／ {t.phase} ／ {t.id.slice(0, 8)}</option>)}
      </select></label>
      <label>不成立の種類 <select value={category} onChange={(event) => setCategory(failureCategorySchema.parse(event.currentTarget.value))}>{failureCategorySchema.options.map((c) => <option key={c} value={c}>{failureLabels[c]}</option>)}</select></label>
      <label>具体的な理由 <textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.currentTarget.value)} /></label>
      <button disabled={!original || !reason.trim() || !!recorded || pending} onClick={() => onFailure({ originalRunId: originalId, category, reason: reason.trim() })}>技術的不成立を記録し、課題を中断</button>
      {recorded && <p>記録済みの理由：{recorded.reason}</p>}
      <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} /> 原因を解消し、本人から再実施への同意を得た</label>
      <button disabled={!recorded || !original || !['complete', 'aborted'].includes(original.phase) || retried || !consent || pending || retryDisabled} onClick={() => onRetry(originalId)}>{retryIntent && !retried ? '記録済みの再実施要求を送信' : '同じ課題を1回再実施'}</button>
      <ul>{management.retries.map((r) => <li key={r.retryRunId}>{r.originalRunId} → {r.retryRunId} ／ {r.reason}</li>)}</ul>
    </details>
    </>}
  </section>
}
