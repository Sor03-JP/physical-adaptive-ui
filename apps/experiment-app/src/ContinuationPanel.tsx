import { useState } from 'react'

export default function ContinuationPanel({ participantId, disabled, onContinue }: {
  participantId: string; disabled: boolean; onContinue: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [consent, setConsent] = useState(false)
  return <div className="continuation-panel">
    <h3>同じ参加者の続きから再開する</h3>
    <p>参加者 {participantId} の完了済み課題・送信済みアンケートを引き継ぎ、中断した課題から再実施します。今はJSONのダウンロード・ファイル確認は不要です。</p>
    <p><small>中断した記録は両端末に保管し、最後のデータ保存にまとめて含めます。再実施は元課題につき1回までです。</small></p>
    <label>中断・再開の理由<input value={reason} maxLength={1000} placeholder="例：iPhoneの画面が非表示になり計測が停止した"
      onChange={(event) => setReason(event.currentTarget.value)} /></label>
    <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} /> 原因を解消し、本人から続行・再実施の了承を得た</label>
    <button className="primary" disabled={disabled || !consent || !reason.trim()} onClick={() => onContinue(reason.trim())}>元の記録を端末に保管して、同じ参加者で続ける</button>
    {disabled && <p className="notice">iPhoneの再接続・停止後のデータ回収・端末内保存・処理完了を確認してください。</p>}
  </div>
}
