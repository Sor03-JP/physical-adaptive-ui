import { useState } from 'react'
import Controller from './Controller'
import Sensor from './Sensor'
import { joinSchema } from './protocol'
import type { Identity } from './protocol'

export default function App() {
  const [identity] = useState<Identity>(() => {
    const url = new URL(location.href)
    const room = url.searchParams.get('room') ?? (crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10))
    const role = url.searchParams.get('role') === 'sensor' ? 'sensor' : 'controller'
    const result = joinSchema.safeParse({ room, role })
    const value: Identity = result.success ? result.data : { role, room: (crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)) }
    url.searchParams.set('role', value.role); url.searchParams.set('room', value.room)
    history.replaceState(null, '', url)
    return value
  })
  return <main>
    <h1>身体状態センサー実測</h1>
    <p>本実験前のセンサーデータ取得用です。身体状態の分類・UI適応はまだ行いません。</p>
    <p>接続コード：<strong>{identity.room}</strong> ／ {identity.role === 'controller' ? 'PC操作画面' : 'iPhone取得画面'}</p>
    <p className="notice">データは各画面のメモリに保持します。PCでJSONを保存するまで、ページを閉じたり再読込みしたりしないでください。</p>
    {!import.meta.hot && <p className="error" role="alert">PC連携は開発サーバーで利用してください。</p>}
    {!window.isSecureContext && <p className="error" role="alert">HTTPSのURLで開いてください。</p>}
    {identity.role === 'controller' ? <Controller identity={identity} /> : <Sensor identity={identity} />}
  </main>
}
