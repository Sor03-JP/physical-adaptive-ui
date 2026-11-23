import { expect, it } from 'vitest'
import { createPhoneFlow, phoneFlowSchema, phoneNextStep, validPhoneFlow } from './phone-flow'
import type { PhoneFlow } from './phone-flow'
import { assignments } from './management'
import type { Group, Participant } from './management'
import { TransitTrial, targetTrainIndex } from './tasks'
import type { TaskRun, TrialTaskId } from './tasks'
import { QuestionnaireBook, conditionTaskIds, surveyItems } from './questionnaire'
import { phoneArchiveDigest, phoneArchiveSchema, readPhoneCheckpoint } from './phone-checkpoint'
import type { PhoneArchive } from './phone-checkpoint'
import { TransferCollector, checkpointTransfer, phoneTransferDigest, readTransfer, writeTransfer } from './transfer'
import { MeasurementRecorder } from './recording'
import { estimationConfig } from './estimation'
import { writeQuestionnaireCsv } from './questionnaire-csv'
import type { LoadedCheckpoint } from './checkpoint'

const metadata = { sessionId: 'session', startedAt: '2026-11-13T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 10, userAgent: 'phone' }
function complete(id: string, taskId: TrialTaskId, mode: 'normal' | 'automatic', now: number) {
  const trial = new TransitTrial(id, metadata.sessionId, taskId, now, mode)
  trial.present(now + 1); trial.begin(now + 2, 'phone'); trial.present(now + 3)
  const target = targetTrainIndex(trial.snapshot().problem)
  trial.showDetails(target, now + 99); trial.select(target, now + 100); trial.present(now + 101)
  trial.advance(now + 18003); trial.confirmStopped(now + 18004, 'phone'); trial.present(now + 18005)
  trial.answer(trial.snapshot().problem.trains[target]!.arrival, now + 18006)
  return trial.snapshot()
}
function session(group: Group = 'G1'): PhoneArchive {
  const participant: Participant = { participantId: 'test01', group, rosterId: 'roster' }
  const tasks: TaskRun[] = [], book = new QuestionnaireBook()
  let flow: PhoneFlow = { ...createPhoneFlow(metadata.sessionId), syncedAtMs: 15, consentedAtMs: 20, tutorialPage: 2, stage: 'experiment' }
  const interrupted = new TransitTrial('interrupted-practice', metadata.sessionId, 'P1', 21, 'automatic')
  interrupted.abort(22, 'connection-during-tutorial'); tasks.push(interrupted.snapshot())
  expect(phoneNextStep(participant, tasks, [], flow)).toEqual({ kind: 'practice' })
  tasks.push(complete('practice', 'P1', 'automatic', 2000))
  let now = 21000
  for (let i = 0; i < 9; i++) {
    const step = phoneNextStep(participant, tasks, book.snapshot(), flow)
    if (step.kind === 'task') {
      const task = complete(`trial-${i}`, step.taskId, step.mode, now)
      tasks.push(task)
      expect(phoneNextStep(participant, tasks, book.snapshot(), flow)).toEqual({ kind: 'confirmation', task })
      flow = { ...flow, confirmations: [...flow.confirmations, { taskRunId: task.id, status: 'as-planned', deviations: [], confirmedAtPhoneMs: now + 19000 }] }
      expect(task.startedAtMs! - task.beginRequestedAtMs!).toBe(1)
      expect(task.hiddenAtMs! - task.startedAtMs!).toBe(18000)
      expect(task.timing.answerMs).toBe(10000)
      expect(task.events.find((e) => e.type === 'view-requested')?.action).toBe('phone-start-confirmed')
      expect(task.events.find((e) => e.type === 'stop-confirmed')?.action).toBe('phone')
    } else if (step.kind === 'survey') {
      const ids = step.target === 'final' ? book.snapshot().map((run) => run.id) : conditionTaskIds(tasks, step.target)
      book.open(step.target, metadata.sessionId, step.target, ids, now, tasks); book.present(step.target, now + 1)
      expect(book.active!.items).toEqual(surveyItems(step.target))
      for (const item of book.active!.items.filter((item) => item.required)) book.answer(step.target, item.id, item.choices[0]!.value, now + 2)
      book.submit(step.target, now + 3); book.dismiss()
    } else throw new Error(`Unexpected step: ${step.kind}`)
    now += 20000
  }
  expect(phoneNextStep(participant, tasks, book.snapshot(), flow)).toEqual({ kind: 'done' })
  const recorder = new MeasurementRecorder(metadata, estimationConfig, () => 1011)
  for (let t = 40; t <= 1000; t += 20) recorder.append({ receivedAtMs: t, eventTimestampMs: t, reportedIntervalRaw: 0.0167, receivedIntervalMs: null,
    acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: null, rotationRate: null })
  recorder.evaluate(1010); recorder.stop(now, 'manual')
  return phoneArchiveSchema.parse({ format: 'physical-adaptive-phone-checkpoint', version: 1, metadata, participant,
    completion: recorder.completion, config: recorder.estimationConfig, savedThroughMs: now + 1,
    tasks, questionnaires: book.snapshot(), samples: recorder.batch(0), estimates: recorder.estimateBatch(0), phoneFlow: { ...flow, stage: 'transfer' } })
}
function collectorFor(archive: PhoneArchive) {
  const collector = new TransferCollector(archive.metadata, 5000, archive.config)
  collector.setParticipant(archive.participant)
  // Last-task status arrives before the full history, so insertion order differs.
  collector.updateTask(archive.tasks.at(-1)!)
  archive.tasks.forEach((task) => collector.updateTask(task))
  collector.updateQuestionnaires(archive.questionnaires); collector.updatePhoneFlow(archive.phoneFlow)
  collector.updateStatus(archive.samples.length, archive.completion, archive.estimates.length)
  return collector
}
function saved(archive: PhoneArchive): LoadedCheckpoint {
  const { samples, estimates, ...header } = archive
  return { key: 'sensor:room:session', savedAt: metadata.startedAt, header, samples, estimates, sampleCount: samples.length, estimateCount: estimates.length }
}

it.each(['G1', 'G2', 'G3', 'G4'] as const)('completes %s entirely with the existing six tasks and three questionnaires', (group) => {
  const archive = session(group)
  expect(archive.tasks.filter((task) => task.purpose === 'main').map((task) => [task.mode, task.taskId])).toEqual(
    assignments[group].flatMap((block) => [1, 2, 3].map((n) => [block.mode, `${block.set}${n}`])))
  expect(archive.phoneFlow!.confirmations).toHaveLength(6)
  expect(archive.questionnaires).toHaveLength(3)
  expect(writeQuestionnaireCsv(archive.questionnaires, archive.participant).split('\r\n')).toHaveLength(16)
})

it('matches phone memory, restored phone storage, PC storage and JSON, preserving clocks and original records', async () => {
  const archive = session(), before = structuredClone(archive), pc = collectorFor(archive)
  await expect(phoneTransferDigest(pc.export())).rejects.toThrow()
  pc.receive(0, archive.samples, 600); pc.receiveEstimates(0, archive.estimates)
  const hash = await phoneArchiveDigest(archive)
  expect(await phoneTransferDigest(pc.export())).toBe(hash)
  expect(await phoneArchiveDigest(readPhoneCheckpoint(saved(archive)))).toBe(hash)
  const delta = pc.checkpoint(0, 0), disk = { ...saved(archive), header: delta.header }
  expect(await phoneTransferDigest(checkpointTransfer(disk))).toBe(hash)
  const parsed = readTransfer(writeTransfer(pc.export()))
  expect(parsed).toEqual(pc.export())
  expect(pc.unconfirmedTaskRuns).toEqual([])
  expect(pc.export().movementConfirmations).toEqual([])
  expect(pc.export().phoneFlow!.confirmations[0]).not.toHaveProperty('confirmedAtControllerMs')
  expect(await phoneArchiveDigest({ ...archive, savedThroughMs: archive.savedThroughMs + 100 })).toBe(hash)
  expect(archive).toEqual(before)
})

it('detects changed samples, answers, configuration and confirmations even with identical counts', async () => {
  const archive = session(), hash = await phoneArchiveDigest(archive)
  const changes = [
    (copy: PhoneArchive) => { copy.samples[0]!.acceleration!.x = 99 },
    (copy: PhoneArchive) => { copy.questionnaires[0]!.answers.q1 = 2 },
    (copy: PhoneArchive) => { copy.config!.stationaryThreshold = 0.9 },
    (copy: PhoneArchive) => { copy.phoneFlow!.confirmations[0]!.confirmedAtPhoneMs++ },
  ]
  for (const change of changes) {
    const copy = structuredClone(archive); change(copy)
    expect(await phoneArchiveDigest(copy)).not.toBe(hash)
  }
})

it('rejects consent, session, confirmation-clock and premature-transfer inconsistencies', () => {
  const flow = createPhoneFlow('session'), archive = session()
  expect(phoneFlowSchema.safeParse({ ...flow, stage: 'tutorial' }).success).toBe(false)
  expect(phoneFlowSchema.safeParse({ ...flow, syncedAtMs: 20, consentedAtMs: 19, stage: 'tutorial' }).success).toBe(false)
  expect(validPhoneFlow({ ...archive.phoneFlow!, sessionId: 'other' }, 'session', archive.tasks)).toBe(false)
  const early = structuredClone(archive)
  early.phoneFlow!.confirmations[0]!.confirmedAtPhoneMs = 0
  expect(phoneArchiveSchema.safeParse(early).success).toBe(false)
  expect(phoneArchiveSchema.safeParse({ ...archive, questionnaires: archive.questionnaires.slice(0, 2) }).success).toBe(false)
  expect(phoneArchiveSchema.safeParse({ ...archive, completion: null }).success).toBe(false)
  expect(phoneArchiveSchema.safeParse({ ...archive, phoneFlow: { ...archive.phoneFlow!, confirmations: [] } }).success).toBe(false)
})

it('retains restart links without changing original data and ignores regressed PC flow snapshots', () => {
  const archive = session(), before = structuredClone(archive), pc = collectorFor(archive)
  const next = createPhoneFlow('new-session', 'session', '通信切断後に説明からやり直し')
  expect(next).toMatchObject({ stage: 'consent', syncedAtMs: null, consentedAtMs: null, previousSessionId: 'session', confirmations: [] })
  expect(phoneFlowSchema.safeParse({ ...next, restartReason: null }).success).toBe(false)
  expect(phoneFlowSchema.safeParse({ ...next, sessionId: 'session' }).success).toBe(false)
  expect(pc.updatePhoneFlow({ ...archive.phoneFlow!, stage: 'tutorial' })).toBe(false)
  expect(pc.updatePhoneFlow({ ...archive.phoneFlow!, confirmations: [] })).toBe(false)
  expect(pc.updatePhoneFlow({ ...archive.phoneFlow!, consentedAtMs: 21 })).toBe(false)
  expect(pc.phoneFlow).toEqual(archive.phoneFlow)
  expect(archive).toEqual(before)
})
