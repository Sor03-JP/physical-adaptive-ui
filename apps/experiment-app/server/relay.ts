import type { Plugin, WebSocketClient } from 'vite'
import { joinSchema, messageSchema } from '../src/protocol'
import type { Identity } from '../src/protocol'

/** Development-only transport for the experiment harness, not a library dependency. */
export function measurementRelay(): Plugin {
  return {
    name: 'measurement-relay',
    configureServer(server) {
      const members = new Map<WebSocketClient, Identity>()
      const notify = (room: string) => {
        const peers = [...members].filter(([, identity]) => identity.room === room)
        const sensorUrls = (server.resolvedUrls?.network ?? []).map((base) => {
          const url = new URL(base)
          url.searchParams.set('role', 'sensor'); url.searchParams.set('room', room)
          return url.toString()
        })
        for (const [client] of peers) client.send('measurement:presence', {
          controller: peers.some(([, identity]) => identity.role === 'controller'),
          sensor: peers.some(([, identity]) => identity.role === 'sensor'), sensorUrls, error: '',
        })
      }
      server.ws.on('measurement:join', (raw: unknown, client) => {
        const parsed = joinSchema.safeParse(raw)
        if (!parsed.success) return
        const identity = parsed.data
        const duplicate = [...members].some(([other, member]) => other !== client
          && member.room === identity.room && member.role === identity.role)
        if (duplicate) {
          client.send('measurement:presence', { controller: false, sensor: false, sensorUrls: [],
            error: '同じ接続コードで同じ役割の画面が既に開いています。重複するタブを閉じてください。' })
          return
        }
        const previous = members.get(client)
        if (!previous) client.socket.on('close', () => {
          const old = members.get(client)
          members.delete(client)
          if (old) notify(old.room)
        })
        members.set(client, identity)
        if (previous && previous.room !== identity.room) notify(previous.room)
        notify(identity.room)
      })
      server.ws.on('measurement:message', (raw: unknown, client) => {
        const identity = members.get(client)
        const parsed = messageSchema.safeParse(raw)
        if (!identity || !parsed.success) return
        const fromSensor = parsed.data.type === 'status' || parsed.data.type === 'batch' || parsed.data.type === 'estimates' || parsed.data.type === 'task-history'
        if (fromSensor !== (identity.role === 'sensor')) return
        for (const [peer, member] of members) {
          if (member.room === identity.room && member.role !== identity.role) {
            peer.send('measurement:message', parsed.data)
          }
        }
      })
    },
  }
}
