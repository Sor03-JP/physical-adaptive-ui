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
import { continuedTaskId, prepareContinuation } from './continuation'
import { readExperimentFile, writeExperimentFile } from './experiment-file'

const metadata = { sessionId: 'session', startedAt: '2026-11-13T00:00:00.000Z', timeOriginMs: 1000, startedAtMs: 10, userAgent: 'phone' }
function complete(id: string, taskId: TrialTaskId, mode: 'normal' | 'automatic', now: number, sessionId = metadata.sessionId) {
  const trial = new TransitTrial(id, sessionId, taskId, now, mode, { originalSessionId: metadata.sessionId })
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
      expect(task.timing.answerMs).toBeNull()
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
  if (archive.continuation) {
    collector.continuation = archive.continuation
    collector.management = structuredClone(archive.continuation.management)
  }
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

it('resumes an interrupted phone task and exports both sessions with the submitted surveys and original clocks', async () => {
  const base = session(), participant = base.participant!
  const stopped = new TransitTrial('stopped', metadata.sessionId, 'B1', 120000, 'automatic')
  stopped.abort(120001, 'page-hidden')
  const oldTasks = base.tasks.filter((task) => task.purpose === 'practice' || task.mode === 'normal')
  const oldSurveys = base.questionnaires.filter((run) => run.target === 'normal')
  const oldArchive = phoneArchiveSchema.parse({
    ...base, tasks: [...oldTasks, stopped.snapshot()], questionnaires: oldSurveys,
    completion: { endedAtMs: 120001, stopReason: 'page-hidden' },
    phoneFlow: { ...base.phoneFlow!, stage: 'experiment', confirmations: base.phoneFlow!.confirmations.slice(0, 3) },
  })
  const old = collectorFor(oldArchive)
  old.receive(0, oldArchive.samples, 600); old.receiveEstimates(0, oldArchive.estimates)
  expect(old.taskRuns[0].id).toBe('stopped')
  const context = prepareContinuation(old.export(), 'iPhoneが非表示になった', 130000, 'retried-b1')
  const newMetadata = { ...metadata, sessionId: 'resumed', timeOriginMs: 999000 }
  let flow: PhoneFlow = { ...createPhoneFlow(newMetadata.sessionId), stage: 'experiment', tutorialPage: 2, syncedAtMs: 15, consentedAtMs: 20 }
  const newTasks: TaskRun[] = []
  const book = new QuestionnaireBook(context)
  expect(phoneNextStep(participant, newTasks, [], flow, context)).toEqual({ kind: 'task', taskId: 'B1', mode: 'automatic' })
  expect(continuedTaskId(context, newTasks, 'B1', 'automatic')).toBe('retried-b1')
  expect(() => continuedTaskId(context, newTasks, 'B2', 'automatic')).toThrow('続行先が一致しません')
  for (const [index, taskId] of (['B1', 'B2', 'B3'] as const).entries()) {
    const task = complete(continuedTaskId(context, newTasks, taskId, 'automatic') ?? taskId, taskId, 'automatic', 30 + index * 20000, newMetadata.sessionId)
    newTasks.push(task)
    expect(phoneNextStep(participant, newTasks, [], flow, context)).toEqual({ kind: 'confirmation', task })
    flow = { ...flow, confirmations: [...flow.confirmations, { taskRunId: task.id, status: 'as-planned', deviations: [], confirmedAtPhoneMs: task.endedAtMs! + 1 }] }
  }
  expect(phoneNextStep(participant, newTasks, [], flow, context)).toEqual({ kind: 'survey', target: 'automatic' })
  book.open('automatic-after-resume', newMetadata.sessionId, 'automatic', conditionTaskIds(newTasks, 'automatic'), 60000, newTasks)
  book.present('automatic-after-resume', 60001)
  for (const item of book.active!.items.filter((item) => item.required)) book.answer('automatic-after-resume', item.id, item.choices[0]!.value, 60002)
  book.submit('automatic-after-resume', 60003)
  expect(phoneNextStep(participant, newTasks, book.snapshot(), flow, context)).toEqual({ kind: 'survey', target: 'final' })
  book.open('final-after-resume', newMetadata.sessionId, 'final', [oldSurveys[0].id, 'automatic-after-resume'], 60004, newTasks)
  book.present('final-after-resume', 60005)
  book.answer('final-after-resume', 'comparison', book.active!.items[0]!.choices[0]!.value, 60006)
  book.submit('final-after-resume', 60007)
  expect(phoneNextStep(participant, newTasks, book.snapshot(), flow, context)).toEqual({ kind: 'done' })
  const resumed = phoneArchiveSchema.parse({
    ...base, metadata: newMetadata, continuation: context, tasks: newTasks, questionnaires: book.snapshot(),
    completion: { endedAtMs: 60008, stopReason: 'manual' }, savedThroughMs: 60008,
    phoneFlow: { ...flow, stage: 'transfer' },
  })
  const pc = collectorFor(resumed)
  pc.receive(0, resumed.samples, 700); pc.receiveEstimates(0, resumed.estimates)
  expect(await phoneTransferDigest(pc.export())).toBe(await phoneArchiveDigest(resumed))
  const records = [old.export(), pc.export()]
  expect(readExperimentFile(writeExperimentFile(records))).toEqual(records)
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
