import { useState } from 'react'
import tutorialVideo from './assets/transit-tutorial.mp4'
import { taskTiming } from './task-schema'
import type { ReactNode } from 'react'
import type { PhoneFlow } from './phone-flow'
import type { phoneNextStep } from './phone-flow'
import type { TaskRun } from './task-schema'
import type { MovementConfirmationInput } from './movement-confirmation'
import MovementConfirmationPanel from './MovementConfirmationPanel'

export default function PhoneFlowScreen({ flow, step, tasks, participantId, connected, interrupted, recovered, stopped, pending, error, transferState, audioControls, sensorReady, onPrepare,
  onAccept, onTutorialNext, onPractice, onPracticeComplete, onNext, onReconnect, onResume, onRestart, onConfirmMovement, onStop }: {
  flow: PhoneFlow; step: ReturnType<typeof phoneNextStep> | null; tasks: TaskRun[]; participantId: string
  connected: boolean; interrupted: boolean; recovered: boolean; stopped: boolean; pending: boolean; error: string; transferState: string
  audioControls: ReactNode
  sensorReady: boolean; onPrepare: () => void
  onAccept: () => void; onTutorialNext: () => void; onPractice: () => void; onPracticeComplete: () => void; onNext: () => void
  onReconnect: () => void; onResume: () => void; onRestart: () => void; onConfirmMovement: (input: MovementConfirmationInput) => void
  onStop: () => void
}) {
  const [agreed, setAgreed] = useState(false)
  const practiceComplete = tasks.some((task) => task.purpose === 'practice' && task.phase === 'complete')
  const transfer = flow.stage === 'transfer'
  const needsRecovery = recovered && !transfer
  const restart = <button disabled={pending} onClick={onRestart}>実験者用：記録を残して最初からやり直す</button>
  return <section className="phone-flow-screen mobile-screen" aria-label="iPhoneの実験進行">
    <div className="mobile-content">
      <header className="mobile-meta">
        <span>{flow.stage === 'consent' ? '説明・同意' : flow.stage === 'tutorial' ? 'チュートリアル' : transfer ? '終了・データ転送' : '本番'}</span>
        {participantId && <span>参加者 <span translate="no">{participantId}</span></span>}
      </header>
      {error && <p className="error callout" role="alert">{error}</p>}
      {needsRecovery || (stopped && !transfer) ? <>
        <h1>計測が中断しました</h1><p>保存できた記録は保持しています。実験者にお知らせください。この記録を回収するにはPCとの接続を戻してください。</p>
        <button disabled={pending} onClick={onReconnect}>PCとの接続を確認する</button>{restart}
      </> : interrupted ? <>
        <h1>PCとの接続を確認してください</h1>
        <p>説明・練習中に接続が切れたため、進行を止めています。同じWi-Fiに接続し、この画面を閉じずにお待ちください。</p>
        <p role="status">{connected ? 'PCとの同期を確認できました。続け方を選んでください。' : 'PCとの同期を確認中です。'}</p>
        <div className="mobile-actions">
          <button className="primary" disabled={!connected || pending} onClick={onResume}>続きから始める</button>
          <button disabled={pending} onClick={onReconnect}>再接続を確認</button>
          <button disabled={!connected || pending} onClick={onRestart}>最初からやる（リセット）</button>
        </div>
        <p><small>計測途中で止まった練習問題は、元の練習記録を残して、その問題の最初から行います。</small></p>
      </> : flow.stage === 'consent' ? <>
        <h1>実験の説明・注意事項</h1>
        <dl className="consent-guide">
          <div><dt>最も早く着く便を選ぶ</dt><dd>今から乗れる3路線の便を、遅延を含めて比べます。詳細で到着見込みを確認し、最も早く着く便の「この便を選ぶ」を押してください。</dd></div>
          <div><dt>立ち止まって回答する</dt><dd>問題文を理解してから候補を表示します。{taskTiming.displayMs / 1000}秒後に情報が消えます。実験者が停止を確認したら、到着時刻を4桁で{taskTiming.answerMs / 1000}秒以内に回答してください。不明なら「分からない」を選んでください。</dd></div>
          <div><dt>音を合図に動作を切り替える</dt><dd>動作の順番は、各課題の問題文に表示します。早く選べた場合もその順番に従い、短い音で次の動作に切り替えてください。長い音が鳴ったら、安全に立ち止まってください。</dd></div>
        </dl>
        <section className="callout notice">
          <h2>安全を優先してください</h2>
          <p>危険や体調不良を感じたとき、参加をやめたいときは実験者に伝え、いつでも中止できます。無理に操作する必要はありません。</p>
        </section>
        <p><small>この画面を表示したままにし、画面のロックや再読み込みはしないでください。</small></p>
        {!sensorReady && <><p>センサー・合図音を準備してください。</p><button disabled={pending} onClick={onPrepare}>センサー利用を許可・準備</button></>}
        {!connected && <p role="status">PCとの最初の同期を確認しています。</p>}
        <div className="mobile-actions consent-actions">
          <label className="consent-choice"><input type="checkbox" name="experimentConsent" checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />説明を理解し、参加に同意します。</label>
          <button className="primary" disabled={!agreed || !connected || !sensorReady || pending} onClick={onAccept}>同意してチュートリアルへ</button>
        </div>
      </> : flow.stage === 'tutorial' ? <>
        <h1>チュートリアル {flow.tutorialPage + 1}／3</h1>
        {flow.tutorialPage === 0 ? <>
          <p>一覧の時刻は定刻です。路線をタップして発車・到着見込みを確認し、「一覧に戻る」で他の路線を見比べます。詳細の「この便を選ぶ」で選択でき、選び直しもできます。</p>
          <p>情報が消えたら、安全に立ち止まってください。実験者が停止を確認した後、到着時刻を4桁で回答します。例えば09:30は0930です。</p>
          <details className="tutorial-demo">
            <summary>操作例の動画を見る</summary>
            <video src={tutorialVideo} width={540} height={900} controls playsInline preload="none">
              動画を再生できない場合は、上の説明を読んで進んでください。
            </video>
          </details>
          <button className="primary" disabled={pending || !connected} onClick={onTutorialNext}>操作方法を確認した</button>
        </> : flow.tutorialPage === 1 ? <>
          {audioControls}
          <button className="primary" disabled={pending || !connected} onClick={onTutorialNext}>合図音を確認した</button>
        </> : <>
          <p>本番とは異なる駅・時刻の問題で、選択から停止後の回答まで練習します。</p>
          <button className="primary" disabled={pending || !connected} onClick={practiceComplete ? onPracticeComplete : onPractice}>
            {practiceComplete ? '練習を終了して本番へ' : '練習問題を表示'}
          </button>
        </>}
      </> : transfer ? <>
        <h1>{transferState === 'verified' ? 'PCへの転送・内容確認が完了しました' : 'PCへ実験データを転送します'}</h1>
        <p>実験とアンケートの記録は、このiPhoneに保存しています。Macと同じWi-Fiに戻り、同じ接続コードのPC画面を開いてください。画面は更新せず、このままお待ちください。</p>
        <p role="status" className={transferState === 'verified' ? 'callout success' : 'callout'}>{transferState === 'verified' ? '実験者がPCでJSON・アンケートCSVを保存し、保存ファイルを確認します。案内をお待ちください。'
          : transferState === 'checking' ? '端末内の保存データを検証しています。'
          : transferState === 'mismatch' ? 'PCとiPhoneの内容が一致しません。再接続して確認するか、元の記録を残してやり直してください。'
          : transferState === 'error' ? '保存データの検証が完了していません。上のエラーを確認し、再接続・再確認するか、元の記録を残してやり直してください。'
          : '接続が戻ると自動転送し、PCとiPhoneの記録内容を照合します。完了するまで端末の記録は残します。'}</p>
        {transferState !== 'verified' && <><button className="primary" disabled={pending} onClick={onReconnect}>再接続して転送を確認</button>{restart}</>}
      </> : <>
        <h1>本番の実験</h1>
        <p>ここからはPCとの通信が切れても、iPhoneで実験とアンケートを続けられます。</p>
        {step?.kind === 'confirmation' ? <p>動作の確認が終わるまでお待ちください。</p> : step?.kind === 'task' ? <>
          <p>次は課題{step.taskId.slice(1)}／3です。</p>
          <button className="primary" disabled={pending} onClick={onNext}>次の問題文を表示</button>
        </> : step?.kind === 'survey' ? <>
          <p>立ち止まった状態で、{step.target === 'final' ? '最後の比較アンケート' : '直前の3課題のアンケート'}に回答します。</p>
          <button className="primary" disabled={pending} onClick={onNext}>アンケートへ</button>
        </> : <p role="status">次の操作を準備しています。</p>}
        <MovementConfirmationPanel tasks={tasks} history={flow.confirmations} disabled={pending} onSave={onConfirmMovement} />
      </>}
      {pending && <p role="status">保存・確認中です。この画面を開いたままお待ちください。</p>}
      {!stopped && !transfer && <footer className="mobile-footer"><button className="stop-recording" onClick={onStop}>実験を中止</button></footer>}
    </div>
  </section>
}
