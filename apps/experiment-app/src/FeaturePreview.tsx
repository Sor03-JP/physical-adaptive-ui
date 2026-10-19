import { useState } from 'react'
import type { TransferCollector } from './transfer'

const number = (value: number | undefined) => value === undefined ? '—' : value.toFixed(3)

export default function FeaturePreview({ collector }: { collector: TransferCollector | null }) {
  const [windowInput, setWindowInput] = useState('')
  const windowMs = Number(windowInput)
  const validWindow = Number.isFinite(windowMs) && windowMs > 0
  const features = validWindow ? collector?.features(windowMs) : null
  return <section>
    <h2>特徴量の確認</h2>
    <label>確認する時間窓（ms）<input type="number" min="0" step="any" value={windowInput}
      onChange={(event) => setWindowInput(event.currentTarget.value)} /></label>
    <p><small>PC受信済みの記録末尾を基準に計算します。停止後は値を維持します。この時間窓は特徴量の閲覧用で、iPhone側の自動推定設定は変えません。</small></p>
    {!validWindow ? <p>正の時間窓を入力してください。</p> : !features ? <p>記録データの受信待ちです。</p> : <>
      <p>受信時刻 {features.startAtMs.toFixed(1)}〜{features.endAtMs.toFixed(1)} ms ／ {features.sampleCount}件</p>
      <p>窓内の最大受信間隔（両端の空白を含む）：{number(features.maximumGapMs)} ms</p>
      <table><caption>3軸合成加速度の統計量（m/s²）</caption>
        <thead><tr><th>種類</th><th>有効／欠損件数</th><th>平均</th><th>標準偏差</th><th>RMS</th><th>変動幅</th></tr></thead>
        <tbody>{([
          ['重力を除いた加速度', features.acceleration],
          ['重力込み加速度', features.accelerationIncludingGravity],
        ] as const).map(([label, stats]) => <tr key={label}>
          <th>{label}</th><td>{stats?.validCount ?? 0}／{features.sampleCount - (stats?.validCount ?? 0)}</td>
          <td>{number(stats?.mean)}</td><td>{number(stats?.standardDeviation)}</td>
          <td>{number(stats?.rootMeanSquare)}</td><td>{number(stats?.range)}</td>
        </tr>)}</tbody>
      </table>
      <p><small>各イベントの合成加速度を同じ重みで集計します。欠損は0で埋めず、両種類の加速度を別々に扱います。記録開始前や通信待ちの範囲も窓に含まれる場合があります。</small></p>
    </>}
  </section>
}
