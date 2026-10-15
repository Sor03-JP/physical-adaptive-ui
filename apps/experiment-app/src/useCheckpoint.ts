import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionJournal, saveSetting } from './checkpoint'
import type { CheckpointDelta, LoadedCheckpoint } from './checkpoint'

export function useCheckpoint(role: 'controller' | 'sensor', room: string, handlers: {
  snapshot: (sampleStart: number, estimateStart: number) => CheckpointDelta | null
  restore: (saved: LoadedCheckpoint) => void
}) {
  const callbacks = useRef(handlers); callbacks.current = handlers
  const journal = useRef(new SessionJournal(role, room))
  const counts = useRef({ sessionId: '', samples: 0, estimates: 0 })
  const loaded = useRef(false), archiving = useRef(false)
  const pending = useRef<Promise<boolean> | null>(null)
  const [state, setState] = useState({ ready: false, error: '', savedAt: '', restored: false })
  const flush = useCallback((): Promise<boolean> => {
    if (!loaded.current || archiving.current) return Promise.resolve(false)
    // Explicit callers wait for their own latest snapshot, even if a write is in flight.
    const previous = pending.current ?? Promise.resolve(true)
    const work = previous.then(async () => {
      try {
        let delta = callbacks.current.snapshot(counts.current.samples, counts.current.estimates)
        if (!delta) return true
        if (delta.sessionId !== counts.current.sessionId) delta = callbacks.current.snapshot(0, 0)
        if (!delta) return true
        const saved = await journal.current.save(delta)
        counts.current = { sessionId: delta.sessionId, samples: saved.sampleCount, estimates: saved.estimateCount }
        setState((s) => ({ ...s, savedAt: saved.savedAt, error: '' }))
        return true
      } catch (cause) {
        setState((s) => ({ ...s, error: cause instanceof Error ? cause.message : '端末内への保存に失敗しました。' }))
        return false
      }
    })
    pending.current = work
    void work.then(() => { if (pending.current === work) pending.current = null })
    return work
  }, [])
  useEffect(() => {
    let disposed = false
    void (async () => {
      const saved = await journal.current.active()
      if (disposed) return
      if (saved) {
        callbacks.current.restore(saved)
        counts.current = { sessionId: saved.key.slice(saved.key.lastIndexOf(':') + 1), samples: saved.sampleCount, estimates: saved.estimateCount }
      }
      loaded.current = true
      setState({ ready: false, error: '', savedAt: saved?.savedAt ?? '', restored: saved !== null })
      // Reading alone does not establish that the browser permits writes.
      await saveSetting(`probe:${role}:${room}`, new Date().toISOString())
      if (!disposed) setState((s) => ({ ...s, ready: true }))
    })().catch((cause) => { if (!disposed) setState((s) => ({ ...s, error: String(cause) })) })
    const timer = window.setInterval(() => { if (!pending.current) void flush() }, 1000)
    const save = () => { void flush() }
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', save)
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save) }
  }, [flush, role, room])
  const archive = useCallback(async () => {
    if (archiving.current) throw new Error('保存処理中です。')
    if (!await flush()) throw new Error('最新データを保存できないため、記録を保持します。')
    archiving.current = true
    try {
      // No periodic save can re-activate the archived session after this point.
      await pending.current
      await journal.current.archive()
      counts.current = { sessionId: '', samples: 0, estimates: 0 }
      setState((s) => ({ ...s, savedAt: '', restored: false }))
    } finally { archiving.current = false }
  }, [flush])
  return { ...state, flush, archive, journal: journal.current }
}
