import { describe, expect, it } from 'vitest'
import { clockResult, representative, ResearchRecorder, researchLogSchema } from './research-log'
import type { ClockProbe } from './research-log'
import { TransferCollector, readTransfer, writeTransfer } from './transfer'
import { messageSchema } from './protocol'

function reply(recorder: ResearchRecorder, probe: ClockProbe, t1: number, latency = 10, origin = 1000) {
  return recorder.receive({ ...probe, type: 'clock-reply', phoneReceivedAtMs: t1 - 800 + latency,
    phoneSentAtMs: t1 - 800 + latency + 2, phoneTimeOriginMs: origin }, t1 + latency * 2 + 2)
}

describe('PC observation and clock records', () => {
  it('derives the offset in the direction phone + offset = PC and retains four timestamps', () => {
    expect(clockResult({ probeId: 'one', controllerSentAtMs: 1000, phoneReceivedAtMs: 210,
      phoneSentAtMs: 212, controllerReceivedAtMs: 1022, phoneTimeOriginMs: 1000 })).toEqual({ offsetMs: 800, roundTripMs: 20 })
    const recorder = new ResearchRecorder('s', 1000)
    recorder.begin('start', 1000)
    for (let i = 0; i < 5; i++) {
      const now = 1000 + i * 100
      const probe = recorder.poll(now)!
      expect(probe.type).toBe('clock-probe')
      expect(reply(recorder, probe, now, [30, 20, 5, 25, 40][i])).toBe(true)
      expect(reply(recorder, probe, now)).toBe(false) // Duplicate reply.
    }
    expect(recorder.busy).toBe(false)
    expect(recorder.hasStartCalibration).toBe(true)
    const round = recorder.snapshot().rounds[0]!
    expect(round).toMatchObject({ attempts: 5, failures: 0, endedAtMs: 1482 })
    expect(clockResult(representative(round)!)).toEqual({ offsetMs: 800, roundTripMs: 10 })
    expect(round.exchanges).toHaveLength(5)
    expect(researchLogSchema.parse(recorder.snapshot())).toEqual(recorder.snapshot())
  })
  it('times out missing replies, ignores wrong sessions and closes a wholly failed round', () => {
    const recorder = new ResearchRecorder('s', 1000)
    recorder.begin('start', 1000)
    const first = recorder.poll(1000)!
    expect(recorder.receive({ ...first, type: 'clock-reply', sessionId: 'other', phoneReceivedAtMs: 210,
      phoneSentAtMs: 212, phoneTimeOriginMs: 1000 }, 1022)).toBe(false)
    expect(recorder.poll(2499)).toBeNull()
    for (let now = 2500; now <= 8500; now += 1500) recorder.poll(now)
    expect(recorder.snapshot().rounds[0]).toMatchObject({ attempts: 5, failures: 5, endedAtMs: 8500, exchanges: [] })
    expect(recorder.hasStartCalibration).toBe(false)
    expect(reply(recorder, first, 1000)).toBe(false)
    expect(researchLogSchema.safeParse(recorder.snapshot()).success).toBe(true)
  })
  it('rejects reloaded phone clocks, impossible network timing and late replies', () => {
    const recorder = new ResearchRecorder('s', 1000)
    recorder.begin('start', 1000)
    reply(recorder, recorder.poll(1000)!, 1000, 10, 9999)
    const probe = recorder.poll(1100)!
    recorder.receive({ ...probe, type: 'clock-reply', phoneReceivedAtMs: 400, phoneSentAtMs: 600, phoneTimeOriginMs: 1000 }, 1120)
    const late = recorder.poll(1200)!
    reply(recorder, late, 1200, 1000)
    expect(recorder.snapshot().rounds[0]).toMatchObject({ failures: 3, exchanges: [] })
  })
  it('distinguishes instructions, observed transitions, confirmation and missing observation without backdating', () => {
    const recorder = new ResearchRecorder('s', 1000)
    for (const event of [
      { kind: 'instruction' as const, value: 'walking' as const, controllerAtMs: 100 },
      { kind: 'observation' as const, value: 'transition' as const, controllerAtMs: 300 },
      { kind: 'observation' as const, value: 'walking' as const, controllerAtMs: 1400 },
      { kind: 'observation' as const, value: 'missed' as const, controllerAtMs: 1500 },
    ]) recorder.record({ ...event, taskRunId: null, reportedPhase: null })
    expect(recorder.snapshot().events.map((e) => e.controllerAtMs)).toEqual([100, 300, 1400, 1500])
    expect(() => recorder.record({ kind: 'instruction', value: 'uncertain', controllerAtMs: 1600, taskRunId: null, reportedPhase: null })).toThrow()
    const snapshot = recorder.snapshot(); snapshot.events.length = 0
    expect(recorder.snapshot().events).toHaveLength(4)
  })
  it('round trips observation and calibration with raw data unchanged, including an unfinished calibration', () => {
    const collector = new TransferCollector({ sessionId: 's', startedAt: '2026-10-16T00:00:00.000Z',
      timeOriginMs: 1000, startedAtMs: 10, userAgent: 'test' }, 5000)
    collector.research.record({ kind: 'observation', value: 'stationary', controllerAtMs: 1000, taskRunId: null, reportedPhase: null })
    collector.research.begin('start', 1000)
    const probe = collector.research.poll(1000)!
    expect(messageSchema.parse(probe)).toEqual(probe)
    reply(collector.research, probe, 1000)
    collector.research.poll(1100)
    const data = collector.export()
    expect(data.version).toBe(11)
    expect(readTransfer(writeTransfer(data))).toEqual(data)
    expect(data.samples).toEqual([])
    expect(data.research.events).toHaveLength(1)
    expect(data.research.rounds[0]?.exchanges[0]).toMatchObject({ controllerSentAtMs: 1000, phoneReceivedAtMs: 210 })
    const bad = structuredClone(data)
    bad.research.rounds[0]!.exchanges[0]!.phoneTimeOriginMs = 99
    expect(() => readTransfer(JSON.stringify(bad))).toThrow()
  })
})
