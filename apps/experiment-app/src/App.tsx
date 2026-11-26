import { useEffect, useState } from 'react'
import Controller from './Controller'
import Sensor from './Sensor'
import { pageIdentity } from './protocol'

export default function App() {
  const [identity] = useState(() => pageIdentity(new URL(location.href)))
  useEffect(() => {
    if (identity?.role !== 'controller') return
    const url = new URL(location.href)
    url.searchParams.set('role', identity.role)
    url.searchParams.set('room', identity.room)
    if (url.href !== location.href) history.replaceState(history.state, '', url)
  }, [identity])
  if (!identity) return <main className="phone-page">
    <h1>接続コードを確認してください</h1>
    <p role="alert">PCのコントローラーに表示されたiPhone用URLを、接続コードを含めて開き直してください。</p>
  </main>
  const isController = identity.role === 'controller'
  return <main className={isController ? 'controller-page' : 'phone-page'}>
    <header className="app-header">
      <h1>{isController ? '評価実験コントローラー' : '乗換情報の確認実験'}</h1>
      <p className="connection-code">接続コード <strong translate="no">{identity.room}</strong></p>
    </header>
    {import.meta.env.DEV && <p className="notice">開発用画面です。本実験はビルド後に start:measurement で起動してください。開発中は通信復帰時に画面が更新される場合があります。</p>}
    {!window.isSecureContext && <p className="error" role="alert">HTTPSのURLで開いてください。</p>}
    {identity.role === 'controller' ? <Controller identity={identity} /> : <Sensor identity={identity} />}
  </main>
}
