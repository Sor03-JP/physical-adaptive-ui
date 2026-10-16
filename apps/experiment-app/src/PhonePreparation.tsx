export default function PhonePreparation({ connected, storageReady, storageError, sensorReady, pending, recording, stopped, recovered, practiceReady, practiceFinished, onEnable, onPractice }: {
  connected: boolean; storageReady: boolean; storageError: string; sensorReady: boolean; pending: boolean
  recording: boolean; stopped: boolean; recovered: boolean; practiceReady: boolean; practiceFinished: boolean
  onEnable: () => void; onPractice: () => void
}) {
  let title: string, instruction: string
  if (recovered) {
    title = '実験者にお知らせください'
    instruction = '更新前の記録を復旧しました。このまま実験者の案内をお待ちください。'
  } else if (storageError) {
    title = '準備を確認しています'
    instruction = '保存の準備で問題が起きています。実験者にお知らせください。'
  } else if (!storageReady || !connected) {
    title = '接続・保存を準備しています'
    instruction = 'この画面を開いたままお待ちください。進まない場合は実験者にお知らせください。'
  } else if (stopped) {
    title = '記録を終了しました'
    instruction = '実験者がPCでデータを保存・確認します。案内があるまで、この画面を開いたままお待ちください。'
  } else if (!sensorReady && !recording) {
    title = pending ? 'センサーの許可を確認しています' : 'センサーの利用を許可してください'
    instruction = pending ? '許可を求める画面が出たら、許可してください。' : '下のボタンを押し、許可を求める画面が出たら許可してください。'
  } else if (!recording) {
    title = '準備できました'
    instruction = '実験者がPCで記録を開始します。この画面を開いたままお待ちください。'
  } else if (practiceReady && !practiceFinished) {
    title = 'まずは練習しましょう'
    instruction = '実験者の説明を聞いてから、下のボタンで練習問題を開いてください。'
  } else {
    title = practiceFinished ? '練習が終わりました' : '次の案内をお待ちください'
    instruction = '次の問題は実験者がPCから表示します。このままお待ちください。'
  }
  const enable = connected && storageReady && !storageError && !recovered && !stopped && !recording && !sensorReady
  const practice = connected && storageReady && !storageError && !recovered && recording && practiceReady && !practiceFinished
  return <div className="phone-next" role="status">
    <p className="phone-stage">{recording ? '実験中' : stopped || recovered ? '終了・確認' : '開始前の準備'}</p>
    <h2>{title}</h2>
    <p>{instruction}</p>
    {enable && <button className="primary" disabled={pending} onClick={onEnable}>センサー利用を許可・準備</button>}
    {practice && <button className="primary" onClick={onPractice}>練習問題を表示</button>}
  </div>
}
