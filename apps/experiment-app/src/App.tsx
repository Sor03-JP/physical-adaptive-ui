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
  return <main className={identity.role === 'controller' ? 'controller-page' : undefined}>
    <h1>{identity.role === 'controller' ? '評価実験コントローラー' : '乗換情報の確認実験'}</h1>
    <p>接続コード：<strong>{identity.room}</strong> ／ {identity.role === 'controller' ? 'PC操作画面' : 'iPhone取得画面'}</p>
    {!import.meta.hot && <p className="error" role="alert">PC連携は開発サーバーで利用してください。</p>}
    {!window.isSecureContext && <p className="error" role="alert">HTTPSのURLで開いてください。</p>}
    {identity.role === 'controller' ? <Controller identity={identity} /> : <Sensor identity={identity} />}
  </main>
}
