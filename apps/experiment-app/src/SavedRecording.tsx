import { useState } from 'react'
import { downloadText } from './download'
import { writeQuestionnaireCsv } from './questionnaire-csv'
import type { Participant } from './management'
import type { SurveyRun } from './questionnaire'
import type { RefObject } from 'react'
import { MAX_FILE_BYTES, readRecording } from './recording'
import type { ReadableMotionSample } from './recording'
import { readTransfer, writeTransfer } from './transfer'
import type { TransferCollector } from './transfer'

export default function SavedRecording({ collector, active, reading, setReading, onVerified, guided = false }: {
  guided?: boolean
  collector: RefObject<TransferCollector | null>
  active: boolean
  reading: boolean
  setReading: (reading: boolean) => void
  onVerified: () => void
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
      if (file.size > MAX_FILE_BYTES) throw new Error('too large')
      const text = await file.text()
      let same = false
      try {
        const data = readTransfer(text)
        setImportedParticipant('management' in data ? data.management.participant : null)
        setImportedSurveys('questionnaires' in data ? data.questionnaires : [])
        setImported({ id: data.metadata.sessionId, version: data.version, count: data.samples.length,
          estimates: 'inference' in data ? data.inference.estimates.length : 0,
          tasks: 'tasks' in data ? data.tasks.length : 0,
          practiceTasks: (data.version === 10 || data.version === 11 || data.version === 12) ? data.tasks.filter((task) => task.purpose === 'practice').length : 0,
          researchEvents: 'research' in data ? data.research.events.length : 0,
          clockRounds: 'research' in data ? data.research.rounds.length : 0,
          surveys: 'questionnaires' in data ? data.questionnaires.length : 0,
          submittedSurveys: 'questionnaires' in data ? data.questionnaires.filter((r) => r.phase === 'submitted').length : 0,
          complete: 'recovery' in data && data.recovery ? 'iPhone更新による中断・保存範囲を回収' : data.complete ? 'センサー全件受信・停止確認済み' : '途中データ',
          first: data.samples[0] ?? null, last: data.samples.at(-1) ?? null })
        same = collector.current !== null
          && writeTransfer(collector.current.export()) === writeTransfer(data)
      } catch {
        const data = readRecording(text)
        setImported({ id: data.sessionId, version: data.version, count: data.samples.length, estimates: 0, tasks: 0, practiceTasks: 0, researchEvents: 0, clockRounds: 0, surveys: 0, submittedSurveys: 0, complete: 'iPhone単体記録',
          first: data.samples[0] ?? null, last: data.samples.at(-1) ?? null })
      }
      if (same) onVerified()
      setMessage(same ? '保存したファイルと、この画面の記録が一致しました。保存確認は完了です。'
        : 'この画面の記録とは一致していません。直前に保存したファイルを選び直してください。別の記録のファイルとしては読み込めています。')
    } catch { setError('読込みに失敗しました。実測JSONの形式・サイズ・時刻・件数を確認してください。') }
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
      <h2>{guided ? '2. 保存したファイルを確認する' : '保存したデータを確認する'}</h2>
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
