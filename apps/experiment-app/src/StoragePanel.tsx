import { useState } from 'react'
import type { StoredCheckpoint, SessionJournal } from './checkpoint'
import { checkpointTransfer } from './transfer'
import { loadExperimentRecords, writeExperimentFile } from './experiment-file'
import { downloadText } from './download'

export default function StoragePanel({ state, phone, journal }: {
  state: { ready: boolean; savedAt: string; error: string; restored: boolean }
  phone: { ready: boolean; savedAt: string; error: string; restored: boolean } | null
  journal: SessionJournal
}) {
  const [archives, setArchives] = useState<StoredCheckpoint[]>([])
  const [error, setError] = useState('')
  async function list() { try { setArchives(await journal.list()); setError('') } catch { setError('保存済み記録を読み込めませんでした。') } }
  async function download(key: string) {
    try {
      const saved = await journal.load(key)
      if (!saved) throw new Error('not found')
      const data = checkpointTransfer(saved)
      downloadText(writeExperimentFile(await loadExperimentRecords(data, journal)), `${data.management.participant?.participantId ?? 'unassigned'}_${data.metadata.sessionId}${data.complete && !data.recovery ? '' : '-partial'}.json`, 'application/json')
      setError('')
    } catch { setError('保存済み記録の検証・出力に失敗しました。') }
  }
  return <section><h2>端末内保存・復旧</h2>
    <p>PC：{state.ready ? '保存領域準備済み' : '読込み中／利用不可'} ／ 最終保存：{state.savedAt || '未保存'}{state.restored && ' ／ 更新前の記録を復旧'}</p>
    <p>iPhone：{phone?.ready ? '保存領域準備済み' : '未確認／利用不可'} ／ 最終保存：{phone?.savedAt || '未保存'}{phone?.restored && ' ／ 更新前の記録あり'}</p>
    {(state.error || phone?.error || error) && <p className="error" role="alert">{state.error || phone?.error || error}</p>}
    <p><small>同じURL・ブラウザ内のIndexedDBへ原則1秒ごとに追加保存します。最後の保存完了以降のデータは復旧できない場合があります。iPhoneの更新は中断扱いとし、保存済みデータの回収に使います。本番記録はJSON・CSVでも出力してください。</small></p>
    <button onClick={() => void list()}>PCの保存済み記録を一覧表示</button>
    <ul>{archives.map((a) => <li key={a.key}>{(a.header as { management?: { participant?: { participantId?: string } } })?.management?.participant?.participantId ?? '未指定'} ／ {a.savedAt} ／ {a.sampleCount}件 <button onClick={() => void download(a.key)}>保存済みJSONを出力</button></li>)}</ul>
  </section>
}
