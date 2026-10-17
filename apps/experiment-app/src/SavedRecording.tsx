import { useState } from 'react'
import { downloadText } from './download'
import { writeQuestionnaireCsv } from './questionnaire-csv'
import type { Participant } from './management'
import type { SurveyRun } from './questionnaire'
import type { ReadableMotionSample } from './recording'
import { readSavedFile } from './experiment-file'
import type { ReadableTransfer } from './transfer'

export default function SavedRecording({ active, reading, setReading, onVerified, getRecords }: {
  getRecords: () => Promise<ReadableTransfer[]>
  active: boolean
  reading: boolean
  setReading: (reading: boolean) => void
  onVerified: (record: ReadableTransfer) => void
}) {
  const [imported, setImported] = useState<{ id: string; version: number; count: number; estimates: number; tasks: number; practiceTasks: number; researchEvents: number; clockRounds: number; surveys: number; submittedSurveys: number; complete: string; first: ReadableMotionSample | null; last: ReadableMotionSample | null } | null>(null)
  const [importedSurveys, setImportedSurveys] = useState<SurveyRun[]>([])
  const [importedParticipant, setImportedParticipant] = useState<Participant | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function importFile(file: File | undefined) {
    if (!file || reading) return
    setReading(true); setImported(null); setImportedSurveys([]); setImportedParticipant(null); setError(''); setMessage('')
    try {
      const { records, recording, same } = await readSavedFile(file, getRecords)
      if (records) {
        const data = records.at(-1)!
        setImportedParticipant('management' in data ? data.management.participant : null)
        setImportedSurveys(records.flatMap((record) => 'questionnaires' in record ? record.questionnaires : []))
        setImported({ id: data.metadata.sessionId, version: data.version, count: records.reduce((n, r) => n + r.samples.length, 0),
          estimates: records.reduce((n, r) => n + ('inference' in r ? r.inference.estimates.length : 0), 0),
          tasks: records.reduce((n, r) => n + ('tasks' in r ? r.tasks.length : 0), 0),
          practiceTasks: records.reduce((n, r) => n + ('tasks' in r ? r.tasks.filter((task) => 'purpose' in task && task.purpose === 'practice').length : 0), 0),
          researchEvents: records.reduce((n, r) => n + ('research' in r ? r.research.events.length : 0), 0),
          clockRounds: records.reduce((n, r) => n + ('research' in r ? r.research.rounds.length : 0), 0),
          surveys: records.reduce((n, r) => n + ('questionnaires' in r ? r.questionnaires.length : 0), 0),
          submittedSurveys: records.reduce((n, r) => n + ('questionnaires' in r ? r.questionnaires.filter((s) => s.phase === 'submitted').length : 0), 0),
          complete: records.length > 1 ? `続行元を含む${records.length}件の計測記録（中断記録も保持）` : 'recovery' in data && data.recovery ? 'iPhone更新による中断・保存範囲を回収' : data.complete ? 'センサー全件受信・停止確認済み' : '途中データ',
          first: records[0]?.samples[0] ?? null, last: data.samples.at(-1) ?? null })
      } else {
        const data = recording
        setImported({ id: data.sessionId, version: data.version, count: data.samples.length, estimates: 0, tasks: 0, practiceTasks: 0, researchEvents: 0, clockRounds: 0, surveys: 0, submittedSurveys: 0, complete: 'iPhone単体記録',
          first: data.samples[0] ?? null, last: data.samples.at(-1) ?? null })
      }
      if (same && records) onVerified(records.at(-1)!)
      setMessage(same ? '保存したファイルと、この画面の記録が一致しました。保存確認は完了です。'
        : 'この画面の記録とは一致していません。直前に保存したファイルを選び直してください。別の記録のファイルとしては読み込めています。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存ファイルを確認できませんでした。') }
    finally { setReading(false) }
  }

  function downloadImportedQuestionnaires() {
    if (!imported || !importedSurveys.length || reading) return
    try {
      downloadText(writeQuestionnaireCsv(importedSurveys, importedParticipant), `${importedParticipant?.participantId ?? 'unassigned'}_${imported.id}_questionnaires.csv`, 'text/csv;charset=utf-8')
      setError(''); setMessage('読み込んだJSONのアンケートをCSVで出力しました。現在のPC記録は変更していません。')
    } catch { setError('アンケートCSVを出力できませんでした。') }
  }

  return (
    <section>
      <h2>2. 保存したファイルを確認する</h2>
      <p>保存ができたか確かめます。「ファイルを選択」から、先ほどダウンロードした末尾が「.json」のファイルを選んでください。通常はPCの「ダウンロード」フォルダにあります。</p>
      <p><small>ファイルの内容を、この画面の記録と自動で照合します。ファイルを編集したり、実験データを書き換えたりする操作ではありません。</small></p>
      <label>保存したデータファイル（.json）<input type="file" accept="application/json,.json" disabled={active || reading}
        onChange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>
      {reading && <p role="status">ファイルの内容を確認しています…</p>}
      {imported && <details><summary>選んだファイルの内容</summary>{importedParticipant && <p>参加者：{importedParticipant.participantId} ／ {importedParticipant.group}</p>}<p>記録ID：{imported.id}<br />{imported.count}件 ／ {imported.complete} ／ 形式v{imported.version}</p>
        <p>推定ログ：{imported.estimates}件</p>
        <p>課題ログ：本番{imported.tasks - imported.practiceTasks}件・練習{imported.practiceTasks}件 ／ 観察・指示：{imported.researchEvents}件 ／ 時刻合わせ：{imported.clockRounds}回</p>
        <p>アンケート：回答済み{imported.submittedSurveys}件 ／ 回答途中{imported.surveys - imported.submittedSurveys}件</p>
        {importedSurveys.length > 0 && <button disabled={reading} onClick={downloadImportedQuestionnaires}>読み込んだJSONのアンケートをCSV出力</button>}
        {imported.version === 1 && <p className="notice">旧形式のintervalMsはAPIの生値です。実受信間隔（ms）とは区別してください。</p>}
        <details><summary>先頭・末尾のサンプル</summary><pre>{JSON.stringify({ first: imported.first, last: imported.last }, null, 2)}</pre></details></details>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}
    </section>
  )
}
