import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskAudio, taskCues } from './task-audio'
import { TransitTrial, taskRunSchema } from './tasks'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'

let now = 100
const nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
const contexts: FakeAudioContext[] = []
class FakeAudioContext {
  constructor() { contexts.push(this) }
  state = 'running'
  onstatechange: (() => void) | null = null
  currentTime = 10
  destination = {}
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createOscillator() {
    const node = { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), onended: null,
      start: vi.fn(), stop: vi.fn() }
    nodes.push(node)
    return node
  }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
}
function trial(taskId: 'A1' | 'A2' | 'A3' = 'A3') {
  const value = new TransitTrial('trial', 'session', taskId, 0, 'automatic')
  value.present(1); value.begin(2); value.present(now)
  return value
}
beforeEach(() => { now = 100; nodes.length = 0; contexts.length = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); vi.stubGlobal('AudioContext', FakeAudioContext) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses only an end cue for stationary tasks and the same 4/11/15-second cues for both UI conditions', () => {
  expect(taskCues(trial('A1').snapshot())).toEqual([{ kind: 'finish', offsetMs: 15000 }])
  expect(taskCues(trial('A2').snapshot())).toEqual(taskCues(trial('A3').snapshot()))
  expect(taskCues(trial().snapshot()).map((c) => c.offsetMs)).toEqual([4000, 11000, 15000])
})

it('schedules once on the phone audio clock and retains requests, not claims of audible playback, in JSON', async () => {
  const audio = new TaskAudio(), value = trial()
  await audio.prepare()
  nodes.length = 0
  now = 120
  audio.schedule(value); audio.schedule(value)
  expect(nodes.map((n) => n.start.mock.calls[0][0])).toEqual([13.98, 20.98, 24.98])
  const events = value.snapshot().events.filter((e) => e.type === 'cue-scheduled')
  expect(events).toHaveLength(3)
  expect(events.map((e) => e.plannedAtMs)).toEqual([4100, 11100, 15100])
  expect(events.every((e) => e.atMs === 120)).toBe(true)
  now = 15100; value.advance(now)
  expect(value.snapshot().phase).toBe('waiting-stop')
  value.confirmStopped(15200, 'phone'); value.present(15201); value.answer('14:03', 15300)
  expect(value.snapshot().events.find((e) => e.type === 'stop-confirmed')?.action).toBe('phone')
  expect(taskRunSchema.parse(value.snapshot())).toEqual(value.snapshot())
  const collector = new TransferCollector({ sessionId: 'session', startedAt: '2026-10-19T00:00:00.000Z', startedAtMs: 0, timeOriginMs: 1000, userAgent: 'test' }, 5000)
  collector.updateTask(value.snapshot())
  expect(readTransfer(writeTransfer(collector.export()))).toMatchObject({ tasks: [value.snapshot()] })
  audio.close()
})

it('cancels pending tones on interruption and does not replay a late or unavailable cue', async () => {
  const audio = new TaskAudio(), value = trial()
  await audio.prepare(); nodes.length = 0; audio.schedule(value)
  now = 5000; audio.cancel(); value.abort(now, 'manual')
  expect(nodes[0].stop).toHaveBeenCalledTimes(1)
  expect(nodes[1].stop).toHaveBeenCalledTimes(2)
  expect(value.snapshot().events.filter((e) => e.type === 'cue-cancelled')).toHaveLength(2)
  expect(taskRunSchema.safeParse(value.snapshot()).success).toBe(true)
  const noAudio = new TaskAudio(), missing = trial()
  noAudio.schedule(missing)
  expect(missing.snapshot().events.filter((e) => e.type === 'cue-unavailable')).toHaveLength(3)
  now = 100; const late = trial(); now = 5000; audio.schedule(late)
  expect(late.snapshot().events.filter((e) => e.type === 'cue-unavailable')).toHaveLength(1)
  audio.close()
})

it('records interruption of the audio context without replaying cues after automatic audio recovery', async () => {
  const audio = new TaskAudio(), value = trial()
  await audio.prepare(); nodes.length = 0; audio.schedule(value)
  now = 2000; contexts[0].state = 'suspended'; contexts[0].onstatechange!()
  expect(audio.ready).toBe(false)
  expect(value.snapshot().events.filter((e) => e.type === 'cue-unavailable')).toHaveLength(3)
  contexts[0].state = 'running'; audio.schedule(value)
  expect(nodes).toHaveLength(3)
  audio.close()
})
