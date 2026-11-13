import { useState } from 'react'
import type { RefObject } from 'react'
import { MAX_FILE_BYTES, readRecording } from './recording'
import type { ReadableMotionSample } from './recording'
import { readTransfer, writeTransfer } from './transfer'
import type { TransferCollector } from './transfer'

export default function SavedRecording({ collector, active, reading, setReading, onVerified }: {
  collector: RefObject<TransferCollector | null>
  active: boolean
  reading: boolean
  setReading: (reading: boolean) => void
  onVerified: () => void
}) {
  const [imported, setImported] = useState<{ id: string; version: number; count: number; complete: string; first: ReadableMotionSample | null; last: ReadableMotionSample | null } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function importFile(file: File | undefined) {
    if (!file || reading) return
    setReading(true); setImported(null); setError('')
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('too large')
      const text = await file.text()
      let same = false
      try {
        const data = readTransfer(text)
        setImported({ id: data.metadata.sessionId, version: data.version, count: data.samples.length,
          complete: data.complete ? '全件受信・停止確認済み' : '途中データ',
          first: data.samples[0] ?? null, last: data.samples.at(-1) ?? null })
        same = data.complete && collector.current?.complete === true
          && writeTransfer(collector.current.export()) === writeTransfer(data)
      } catch {
        const data = readRecording(text)
        setImported({ id: data.sessionId, version: data.version, count: data.samples.length, complete: '旧形式のiPhone単体記録',
          first: data.samples[0] ?? null, last: data.samples.at(-1) ?? null })
      }
      if (same) onVerified()
      setMessage(same ? 'PCの記録と、読み戻した全データが一致しました。'
        : '形式・時刻・件数を確認しました。現在のPC記録との一致確認ではありません。')
    } catch { setError('読込みに失敗しました。実測JSONの形式・サイズ・時刻・件数を確認してください。') }
    finally { setReading(false) }
  }

  return (
    <section>
      <h2>PCで保存ファイルを読み戻す</h2>
      <label>実測JSONファイル<input type="file" accept="application/json,.json" disabled={active || reading}
        onChange={(event) => { void importFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} /></label>
      {imported && <><p>記録ID：{imported.id}<br />{imported.count}件 ／ {imported.complete} ／ 形式v{imported.version}</p>
        {imported.version === 1 && <p className="notice">旧形式のintervalMsはAPIの生値です。実受信間隔（ms）とは区別してください。</p>}
        <details><summary>先頭・末尾のサンプル</summary><pre>{JSON.stringify({ first: imported.first, last: imported.last }, null, 2)}</pre></details></>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}
    </section>
  )
}
