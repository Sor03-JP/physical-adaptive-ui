import { z } from 'zod'

const time = z.number().finite().nonnegative()
export const observedStateSchema = z.enum(['stationary', 'walking', 'running'])
export const observationProtocolSchema = z.strictObject({
  method: z.enum(['state-confirmation', 'post-task-confirmation']),
  instructionTiming: z.strictObject({ firstMs: z.number().positive(), secondMs: z.number().positive() })
    .refine((timing) => timing.secondMs > timing.firstMs, '動作予定の時刻順が不整合です。'),
})
export type ObservationProtocol = z.infer<typeof observationProtocolSchema>
export const researchEventSchema = z.strictObject({
  kind: z.enum(['observation', 'instruction']),
  value: z.enum(['transition', 'stationary', 'walking', 'running', 'uncertain', 'missed']),
  controllerAtMs: time,
  taskRunId: z.string().nullable(),
  reportedPhase: z.string().nullable(),
}).refine((event) => event.kind === 'observation' || observedStateSchema.safeParse(event.value).success,
  '指示には静止・歩行・走行を指定してください。')
export type ResearchEvent = z.infer<typeof researchEventSchema>
export const clockReplySchema = z.strictObject({
  type: z.literal('clock-reply'), sessionId: z.string().min(1), probeId: z.string().min(1),
  phoneReceivedAtMs: time, phoneSentAtMs: time, phoneTimeOriginMs: time,
})
export type ClockReply = z.infer<typeof clockReplySchema>
export type ClockProbe = { type: 'clock-probe'; sessionId: string; probeId: string }
const exchangeTimesSchema = z.strictObject({
  probeId: z.string().min(1), controllerSentAtMs: time, phoneReceivedAtMs: time,
  phoneSentAtMs: time, controllerReceivedAtMs: time, phoneTimeOriginMs: time,
})
type ClockTimestamps = z.infer<typeof exchangeTimesSchema>
const exchangeSchema = exchangeTimesSchema.extend({ offsetMs: z.number().finite(), roundTripMs: time })
.refine((s) => s.controllerReceivedAtMs >= s.controllerSentAtMs && s.phoneSentAtMs >= s.phoneReceivedAtMs
  && s.controllerReceivedAtMs - s.controllerSentAtMs >= s.phoneSentAtMs - s.phoneReceivedAtMs
  && s.offsetMs === clockResult(s).offsetMs && s.roundTripMs === clockResult(s).roundTripMs,
'通信時刻が不整合です。')
export type ClockExchange = z.infer<typeof exchangeSchema>
export function clockResult(s: ClockTimestamps) {
  return {
    // Add this offset to a phone-local performance timestamp to obtain PC-local time.
    offsetMs: ((s.controllerSentAtMs - s.phoneReceivedAtMs) + (s.controllerReceivedAtMs - s.phoneSentAtMs)) / 2,
    roundTripMs: s.controllerReceivedAtMs - s.controllerSentAtMs - (s.phoneSentAtMs - s.phoneReceivedAtMs),
  }
}
const roundSchema = z.strictObject({
  purpose: z.enum(['start', 'end', 'manual']), startedAtMs: time, endedAtMs: time.nullable(),
  interrupted: z.boolean().optional(),
  attempts: z.int().min(0).max(5), failures: z.int().min(0).max(5),
  exchanges: z.array(exchangeSchema).max(5),
  failedProbes: z.array(z.strictObject({ probeId: z.string(), controllerSentAtMs: time, endedAtMs: time,
    reason: z.enum(['timeout', 'late-reply', 'phone-clock-changed', 'invalid-times']) })).max(5),
}).refine((r) => r.attempts === r.exchanges.length + r.failures + ((r.endedAtMs === null || r.interrupted === true) && r.attempts > r.exchanges.length + r.failures ? 1 : 0)
  && r.failures === r.failedProbes.length
  && r.failedProbes.every((s) => s.controllerSentAtMs >= r.startedAtMs && s.endedAtMs >= s.controllerSentAtMs)
  && (r.endedAtMs === null || ((r.attempts === 5 || r.interrupted === true) && r.endedAtMs >= r.startedAtMs))
  && new Set(r.exchanges.map((s) => s.probeId)).size === r.exchanges.length
  && r.exchanges.every((s, i) => i === 0 || s.controllerSentAtMs >= r.exchanges[i - 1]!.controllerReceivedAtMs)
  && r.exchanges.every((s) => s.controllerSentAtMs >= r.startedAtMs && (r.endedAtMs === null || s.controllerReceivedAtMs <= r.endedAtMs)),
'時刻合わせの件数・期間が不整合です。')
export const researchLogSchema = z.strictObject({
  clock: z.literal('controller-local-performance'),
  method: z.literal('four-timestamp-minimum-round-trip'),
  events: z.array(researchEventSchema).max(5000),
  rounds: z.array(roundSchema).max(100),
}).superRefine((log, ctx) => {
  if (log.events.some((e, i) => i > 0 && e.controllerAtMs < log.events[i - 1]!.controllerAtMs))
    ctx.addIssue({ code: 'custom', message: '観察・指示の記録順が不整合です。' })
})
export type ResearchLog = z.infer<typeof researchLogSchema>
export function representative(round: ResearchLog['rounds'][number]) {
  return round.exchanges.reduce<ClockExchange | null>((best, s) => !best || clockResult(s).roundTripMs < clockResult(best).roundTripMs ? s : best, null)
}

/** PC-owned records. Observation timestamps are input times, never inferred movement onsets. */
export class ResearchRecorder {
  private data: ResearchLog = { clock: 'controller-local-performance', method: 'four-timestamp-minimum-round-trip', events: [], rounds: [] }
  private pending: { id: string; sentAtMs: number } | null = null
  private sequence = 0
  readonly sessionId: string
  readonly phoneTimeOriginMs: number
  constructor(sessionId: string, phoneTimeOriginMs: number) {
    this.sessionId = sessionId; this.phoneTimeOriginMs = phoneTimeOriginMs
  }
  get busy() { return this.data.rounds.at(-1)?.endedAtMs === null }
  get hasStartCalibration() { return this.data.rounds.some((r) => r.purpose === 'start' && !r.interrupted && r.endedAtMs !== null && r.exchanges.length > 0) }
  snapshot(): ResearchLog { return structuredClone(this.data) }
  restore(data: ResearchLog, now: number) {
    this.data = researchLogSchema.parse(data)
    this.sequence = this.data.rounds.reduce((n, r) => n + r.attempts, 0)
    const round = this.data.rounds.at(-1)
    if (round?.endedAtMs === null) {
      round.endedAtMs = Math.max(now, round.startedAtMs, round.exchanges.at(-1)?.controllerReceivedAtMs ?? 0)
      round.interrupted = true
    }
    this.pending = null
  }
  record(event: ResearchEvent) {
    const parsed = researchEventSchema.parse(event)
    if (this.data.events.length >= 5000) throw new Error('観察・指示ログの上限に達しました。')
    if (parsed.controllerAtMs < (this.data.events.at(-1)?.controllerAtMs ?? 0)) throw new Error('PC時刻が逆行しています。')
    this.data.events.push(parsed)
  }
  begin(purpose: ResearchLog['rounds'][number]['purpose'], now: number) {
    if (this.busy) return false
    if (this.data.rounds.length >= 100) throw new Error('時刻合わせの上限に達しました。')
    this.data.rounds.push({ purpose, startedAtMs: now, endedAtMs: null, attempts: 0, failures: 0, exchanges: [], failedProbes: [] })
    return true
  }
  private fail(now: number, reason: ResearchLog['rounds'][number]['failedProbes'][number]['reason']) {
    const round = this.data.rounds.at(-1)!
    round.failedProbes.push({ probeId: this.pending!.id, controllerSentAtMs: this.pending!.sentAtMs, endedAtMs: now, reason })
    round.failures++; this.pending = null
  }
  poll(now: number): ClockProbe | null {
    const round = this.data.rounds.at(-1)
    if (!round || round.endedAtMs !== null) return null
    if (this.pending) {
      if (now - this.pending.sentAtMs < 1500) return null
      this.fail(now, 'timeout')
    }
    if (round.attempts === 5) { round.endedAtMs = now; return null }
    const id = `${this.sessionId}:${++this.sequence}`
    round.attempts++; this.pending = { id, sentAtMs: now }
    return { type: 'clock-probe', sessionId: this.sessionId, probeId: id }
  }
  receive(reply: ClockReply, receivedAtMs: number) {
    if (reply.sessionId !== this.sessionId || reply.probeId !== this.pending?.id) return false
    const round = this.data.rounds.at(-1)!
    const timestamps = { probeId: reply.probeId, controllerSentAtMs: this.pending.sentAtMs,
      phoneReceivedAtMs: reply.phoneReceivedAtMs, phoneSentAtMs: reply.phoneSentAtMs,
      controllerReceivedAtMs: receivedAtMs, phoneTimeOriginMs: reply.phoneTimeOriginMs }
    const parsed = exchangeSchema.safeParse({ ...timestamps, ...clockResult(timestamps) })
    if (!parsed.success) this.fail(receivedAtMs, 'invalid-times')
    else if (receivedAtMs - parsed.data.controllerSentAtMs >= 1500) this.fail(receivedAtMs, 'late-reply')
    else if (reply.phoneTimeOriginMs !== this.phoneTimeOriginMs) this.fail(receivedAtMs, 'phone-clock-changed')
    else { round.exchanges.push(parsed.data); this.pending = null }
    if (round.attempts === 5) round.endedAtMs = receivedAtMs
    return true
  }
}
