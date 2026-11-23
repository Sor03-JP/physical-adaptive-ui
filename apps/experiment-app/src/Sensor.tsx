import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { createBrowserMotionSource } from '@physical-adaptive/device-motion'
import type { DeviceMotionSource, MotionSample } from '@physical-adaptive/device-motion'
import { hasCompleteAcceleration, MeasurementRecorder, MAX_SAMPLES } from './recording'
import { BATCH_SIZE } from './recording-schema'
import type { StopReason } from './recording'
import type { Identity, Message, PhoneStatus } from './protocol'
import { useMeasurementTransport } from './transport'
import { useCheckpoint } from './useCheckpoint'
import { readPhoneCheckpoint, phoneArchiveDigest, phoneArchiveSchema } from './phone-checkpoint'
import type { PhoneArchive } from './phone-checkpoint'
import type { Participant } from './management'
import type { Continuation } from './continuation'
import { assessableTasks, emptyManagement } from './management'
import { estimationConfig } from './estimation'
import TransitTaskScreen from './TransitTaskScreen'
import QuestionnaireScreen from './QuestionnaireScreen'
import PhonePreparation from './PhonePreparation'
import { QuestionnaireBook, conditionTaskIds } from './questionnaire'
import { TransitTrial, canStartPractice, taskSnapshots } from './tasks'
import type { ExperimentMode, PresentationMetrics, RenderedTaskContext } from './adaptation'
import type { TaskRun, TrialTaskId } from './tasks'
import type { SurveyRun } from './questionnaire'
import { TaskAudio } from './task-audio'
import { createPhoneFlow, phoneFlowSchema, phoneNextStep } from './phone-flow'
import type { PhoneFlow } from './phone-flow'
import { phoneMovementConfirmationSchema, validMovementConfirmation } from './movement-confirmation'
import type { MovementConfirmationInput } from './movement-confirmation'
import PhoneFlowScreen from './PhoneFlowScreen'

export default function Sensor({ identity }: { identity: Identity }) {
  const source = useRef<DeviceMotionSource | null>(null)
  const audio = useRef(new TaskAudio())
  const flow = useRef<PhoneFlow | undefined>(undefined)
  const [phoneFlow, setPhoneFlow] = useState<PhoneFlow | undefined>(undefined)
  const digest = useRef<string | null>(null)
  const transferAttempt = useRef(0)
  const restoredTransfer = useRef(false)
  const localBusy = useRef(false)
  const [transferState, setTransferState] = useState('')
  const [linkConfirmed, setLinkConfirmed] = useState(false)
  const [connectionDecision, setConnectionDecision] = useState(false)
  const [localPending, setLocalPending] = useState(false)
  function updateFlow(next: PhoneFlow) { flow.current = phoneFlowSchema.parse(next); setPhoneFlow(flow.current) }
  const [audioReady, setAudioReady] = useState(false)
  const recorder = useRef<MeasurementRecorder | null>(null)
  const recovered = useRef<PhoneArchive | null>(null)
  const participant = useRef<Participant | null>(null)
  const clearing = useRef(false)
  const continuation = useRef<Continuation | undefined>(undefined)
  const [recoveryMessage, setRecoveryMessage] = useState('')
  const latest = useRef<MotionSample | null>(null)
  const events = useRef({ total: 0, valid: 0 })
  const enabled = useRef(false)
  const streaming = useRef(false)
  const error = useRef('')
  const generation = useRef(0)
  const trial = useRef<TransitTrial | null>(null)
  const taskHistory = useRef(new Map<string, TaskRun>())
  const questionnaires = useRef(new QuestionnaireBook())
  const [survey, setSurvey] = useState<SurveyRun | null>(null)
  const renderSurvey = useCallback(() => setSurvey(questionnaires.current.active), [])
  const presentSurvey = useCallback((id: string) => {
    questionnaires.current.present(id, performance.now()); renderSurvey()
  }, [renderSurvey])
  const [taskRun, setTaskRun] = useState<TaskRun | null>(null)
  const [dismissedPracticeId, setDismissedPracticeId] = useState<string | null>(null)
  const renderTask = useCallback(() => setTaskRun(trial.current?.snapshot() ?? null), [])
  const presentTask = useCallback((metrics: PresentationMetrics | null = null, rendered?: RenderedTaskContext) => {
    const current = trial.current
    if (!current) return
    const changed = current.present(performance.now(), metrics, rendered)
    audio.current.schedule(current)
    if (changed) renderTask()
  }, [renderTask])
  const advanceTask = useCallback(() => {
    const now = performance.now()
    trial.current?.advance(now)
    trial.current?.updateAdaptation(recorder.current?.latestEstimate ?? null, now)
    renderTask()
  }, [renderTask])
  const [connected, setConnected] = useState(false)
  const [controller, setController] = useState(false)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('センサーの利用許可を待っています。')
  function phoneHeader(current: MeasurementRecorder) {
    return { ...(continuation.current ? { continuation: continuation.current } : {}), ...(flow.current ? { phoneFlow: flow.current } : {}),
      format: 'physical-adaptive-phone-checkpoint' as const, version: 1 as const,
      metadata: current.metadata, participant: participant.current, completion: current.completion,
      config: current.estimationConfig, savedThroughMs: performance.now(),
      tasks: taskSnapshots(taskHistory.current, trial.current?.snapshot() ?? null), questionnaires: questionnaires.current.snapshot() }
  }
  const storage = useCheckpoint('sensor', identity.room, {
    snapshot: (sampleStart, estimateStart) => {
      const current = recorder.current
      if (!current || recovered.current) return null
      return { sessionId: current.metadata.sessionId, sampleStart, estimateStart,
        samples: current.batch(sampleStart, MAX_SAMPLES), estimates: current.estimateBatch(estimateStart, MAX_SAMPLES),
        header: phoneHeader(current) }
    },
    restore: (saved) => {
      recovered.current = readPhoneCheckpoint(saved)
      participant.current = recovered.current.participant
      continuation.current = recovered.current.continuation
      flow.current = recovered.current.phoneFlow; setPhoneFlow(flow.current)
      setRecoveryMessage('更新前の保存データを復旧しました。計測は中断扱いです。PCでデータを回収し、「同じ参加者の続きから再開」または「実験を終了して保存」を選んでください。')
    },
  })

  const finish = useCallback((reason: StopReason) => {
    audio.current.cancel()
    trial.current?.abort(performance.now(), reason)
    renderTask()
    recorder.current?.stop(performance.now(), reason)
    source.current?.stop(); streaming.current = false
  }, [renderTask])
  function feed() {
    if (streaming.current || !source.current) return
    source.current.start((sample) => {
      latest.current = sample; events.current.total++
      if (hasCompleteAcceleration(sample)) events.current.valid++
      if (!flow.current || flow.current.consentedAtMs !== null) recorder.current?.append(sample)
      if (recorder.current?.completion?.stopReason === 'capacity') finish('capacity')
    })
    streaming.current = true
  }
  function snapshot(): PhoneStatus {
    const now = performance.now()
    const current = recorder.current
    const archive = recovered.current
    if (archive) {
      const completion = archive.completion ?? { endedAtMs: archive.savedThroughMs, stopReason: 'recovered-after-reload' as const }
      const validCount = archive.samples.filter(hasCompleteAcceleration).length
      return { ...(archive.continuation ? { continuation: archive.continuation } : {}), ...(archive.phoneFlow ? { phoneFlow: archive.phoneFlow, transferDigest: digest.current, transferAttempt: transferAttempt.current } : {}), type: 'status', streaming: false, visible: !document.hidden, ready: false, permission: 'prompt', error: error.current,
        receivedEventCount: archive.samples.length, validEventCount: validCount,
        participant: archive.participant, recovered: true, recoverySavedThroughMs: archive.savedThroughMs,
        storage: { ready: storage.ready, savedAt: storage.savedAt, error: storage.error, restored: true },
        recoveredTasks: archive.tasks, questionnaires: archive.questionnaires, metadata: archive.metadata, completion, taskRun: archive.tasks.at(-1) ?? null,
        estimationConfig: archive.config, estimateCount: archive.estimates.length, latestEstimate: archive.estimates.at(-1) ?? null,
        count: archive.samples.length, completeAccelerationCount: validCount,
        latest: archive.samples.at(-1) ?? null, elapsedMs: Math.max(0, completion.endedAtMs - archive.metadata.startedAtMs), sinceLastSampleMs: null }
    }
    const view = current?.view(now)
    return {
      ...(continuation.current ? { continuation: continuation.current } : {}),
      ...(flow.current ? { phoneFlow: flow.current, transferDigest: digest.current, transferAttempt: transferAttempt.current } : {}),
      type: 'status', participant: participant.current, recovered: false, recoverySavedThroughMs: null,
      storage: { ready: storage.ready, savedAt: storage.savedAt, error: storage.error, restored: storage.restored }, streaming: streaming.current, visible: !document.hidden, ready: enabled.current && audio.current.ready && events.current.valid > 0 && !document.hidden,
      permission: source.current?.getPermission() ?? 'prompt', error: error.current,
      receivedEventCount: events.current.total, validEventCount: events.current.valid,
      recoveredTasks: [], questionnaires: questionnaires.current.snapshot(),
      metadata: current?.metadata ?? null, completion: current?.completion ?? null, taskRun: trial.current?.snapshot() ?? null,
      estimationConfig: current?.estimationConfig ?? null, estimateCount: current?.estimateCount ?? 0,
      latestEstimate: current?.latestEstimate ?? null,
      count: view?.count ?? 0, completeAccelerationCount: view?.completeAccelerationCount ?? 0,
      latest: latest.current, elapsedMs: view?.elapsedMs ?? 0,
      sinceLastSampleMs: latest.current === null ? null : Math.max(0, now - latest.current.receivedAtMs),
    }
  }
  async function receive(message: Message) {
    try {
      const sessionId = recorder.current?.metadata.sessionId ?? recovered.current?.metadata.sessionId
      if (message.type === 'phone-ack' && message.sessionId === sessionId && flow.current) {
        setLinkConfirmed(true)
        if (!recovered.current && flow.current.syncedAtMs === null) { updateFlow({ ...flow.current, syncedAtMs: performance.now() }); void storage.flush() }
        return
      }
      if (message.type === 'phone-transfer-result' && message.sessionId === sessionId && flow.current) {
        if (message.digest === digest.current && message.attempt === transferAttempt.current) setTransferState(message.matched ? 'verified' : 'mismatch')
        return
      }
      const archive = recovered.current
      if (archive) {
        if ('sessionId' in message && message.sessionId === archive.metadata.sessionId) {
          if (message.type === 'pull-tasks') send({ type: 'task-history', sessionId: message.sessionId, tasks: archive.tasks })
          if (message.type === 'pull') send({ type: 'batch', sessionId: message.sessionId, startIndex: message.startIndex, samples: archive.samples.slice(message.startIndex, message.startIndex + BATCH_SIZE) })
          if (message.type === 'pull-estimates') send({ type: 'estimates', sessionId: message.sessionId, startIndex: message.startIndex, estimates: archive.estimates.slice(message.startIndex, message.startIndex + BATCH_SIZE) })
          if (message.type === 'clear' && !clearing.current) {
            if (flow.current?.stage === 'transfer' && (transferState !== 'verified' || !digest.current)) throw new Error('PCとの転送内容の一致を確認してから、次の参加者へ進んでください。')
            clearing.current = true
            try { await storage.archive(); recovered.current = null; participant.current = null; continuation.current = undefined; flow.current = undefined; setPhoneFlow(undefined); digest.current = null; setTransferState(''); setRecoveryMessage('') }
            finally { clearing.current = false }
          }
        }
        send(snapshot()); return
      }
      const current = recorder.current
      if (message.type === 'start') {
        if (!storage.ready || storage.error) throw new Error('端末内保存を準備してから開始してください。')
        if (current?.metadata.sessionId === message.sessionId) return
        if (current) throw new Error('前の記録をPCで確認・消去してから開始してください。')
        if (!snapshot().ready) throw new Error('センサーの許可・受信確認が完了していません。')
        if (message.continuation && JSON.stringify(message.participant) !== JSON.stringify(message.continuation.participant)) throw new Error('続行する参加者が一致しません。')
        participant.current = message.participant
        continuation.current = message.continuation
        if (message.autonomous) {
          if (!message.participant || message.continuation) throw new Error('端末実験には参加者の割当が必要です。')
          updateFlow(createPhoneFlow(message.sessionId)); digest.current = null; setTransferState(''); setLinkConfirmed(false)
        }
        questionnaires.current = new QuestionnaireBook(message.continuation)
        recorder.current = new MeasurementRecorder({ sessionId: message.sessionId,
          startedAt: new Date().toISOString(), startedAtMs: performance.now(),
          timeOriginMs: performance.timeOrigin, userAgent: navigator.userAgent }, estimationConfig)
        try { feed() } catch (cause) { recorder.current = null; flow.current = undefined; setPhoneFlow(undefined); throw cause }
        error.current = ''
      } else if ('sessionId' in message && current && message.sessionId === current.metadata.sessionId) {
        if (flow.current && ['task-start', 'task-begin', 'task-answer', 'task-abort', 'survey-open'].includes(message.type))
          throw new Error('この実験はiPhoneで進めてください。')
        if (flow.current && current.active && flow.current.stage !== 'transfer' && ['pull', 'pull-estimates', 'pull-tasks'].includes(message.type)) return
        if (message.type === 'pull-tasks') {
          send({ type: 'task-history', sessionId: message.sessionId, tasks: taskSnapshots(taskHistory.current, trial.current?.snapshot() ?? null) })
        }
        if (message.type === 'stop') finish('manual')
        if (message.type === 'clear') {
          if (flow.current?.stage === 'transfer' && (transferState !== 'verified' || !digest.current)) throw new Error('PCとの転送内容の一致を確認してから、次の参加者へ進んでください。')
          if (current.active) throw new Error('記録停止後に消去してください。')
          if (questionnaires.current.answering && !message.forContinuation) throw new Error('アンケートの回答が途中です。送信してから消去してください。')
          if (clearing.current) return
          clearing.current = true
          try { await storage.archive() } finally { clearing.current = false }
          recorder.current = null; participant.current = null; continuation.current = undefined; trial.current = null; taskHistory.current.clear();
          flow.current = undefined; setPhoneFlow(undefined); digest.current = null; setTransferState(''); setConnectionDecision(false)
          questionnaires.current = new QuestionnaireBook(); setDismissedPracticeId(null); renderSurvey(); renderTask(); error.current = ''
        }
        if (message.type === 'survey-open') {
          if (trial.current && !trial.current.complete) throw new Error('課題を終了してからアンケートを表示してください。')
          const previous = trial.current?.snapshot()
          if (previous) taskHistory.current.set(previous.id, previous)
          questionnaires.current.open(message.surveyId, message.sessionId, message.target, message.linkedIds,
            performance.now(), assessableTasks([...(continuation.current?.tasks ?? []), ...taskHistory.current.values()], continuation.current?.management ?? emptyManagement()))
          renderSurvey(); error.current = ''
        }
        if (message.type === 'task-start') {
          if (trial.current?.snapshot().id !== message.runId) {
            if (questionnaires.current.answering) throw new Error('アンケート回答を終了してから次の課題を開始してください。')
            if (!current.active) throw new Error('センサー記録中に課題を開始してください。')
            if (trial.current && !trial.current.complete) throw new Error('現在の課題を終了してから次を開始してください。')
            startTrial(message.runId, message.taskId, message.mode)
            error.current = ''
          }
        }
        if (message.type === 'task-abort' && trial.current?.snapshot().id === message.runId) {
          audio.current.cancel()
          trial.current.abort(performance.now(), message.reason); renderTask(); error.current = ''
        }
        if (message.type === 'task-begin' && trial.current?.snapshot().id === message.runId) {
          if (!current.active) throw new Error('センサー記録中に計測を開始してください。')
          if (!audio.current.ready) throw new Error('iPhoneで合図音を準備してから開始してください。')
          trial.current.begin(performance.now()); renderTask()
        }
        if (message.type === 'task-answer' && trial.current?.snapshot().id === message.runId) {
          trial.current.confirmStopped(performance.now()); renderTask()
        }
        if (message.type === 'pull') send({ type: 'batch', sessionId: message.sessionId,
          startIndex: message.startIndex, samples: current.batch(message.startIndex) })
        if (message.type === 'pull-estimates') send({ type: 'estimates', sessionId: message.sessionId,
          startIndex: message.startIndex, estimates: current.estimateBatch(message.startIndex) })
      }
    } catch (cause) { error.current = cause instanceof Error ? cause.message : '操作を実行できませんでした。' }
    if (!['pull', 'pull-estimates', 'pull-tasks'].includes(message.type)) void storage.flush()
    send(snapshot())
  }
  const { send, reconnect } = useMeasurementTransport(identity, {
    message: receive,
    presence: (presence) => {
      setController(presence.controller)
      if (presence.error) error.current = presence.error
      report()
    },
    connection: (value) => { setConnected(value); if (!value) setLinkConfirmed(false) },
    error: (message) => { error.current = message },
  })

  // Read committed storage state without restarting the sensor lifecycle on each save.
  const readStatus = useEffectEvent(snapshot)
  const { flush } = storage
  useEffect(() => {
    const generationRef = generation
    const taskAudio = audio.current
    const timer = window.setInterval(() => {
      if (!flow.current || flow.current.consentedAtMs !== null) recorder.current?.evaluate(performance.now())
      if (recorder.current?.completion?.stopReason === 'capacity') finish('capacity')
      advanceTask()
      setAudioReady(taskAudio.ready)
      const current = readStatus()
      if (flow.current?.stage !== 'experiment' || !recorder.current?.active) send(current)
      setStatus(error.current || (recorder.current?.active ? '記録中です。操作はPCで行います。'
        : current.ready ? '準備済みです。PCから記録を開始できます。' : 'センサーの許可・受信を確認してください。'))
    }, estimationConfig.updateIntervalMs)
    const hidden = () => {
      if (!document.hidden) return
      finish('page-hidden'); enabled.current = false; void flush()
      send(readStatus())
    }
    const unload = (event: BeforeUnloadEvent) => { if (recorder.current) event.preventDefault() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', unload)
    return () => {
      generationRef.current++; source.current?.stop(); streaming.current = false
      taskAudio.close()
      clearInterval(timer); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', unload)
    }
  }, [send, advanceTask, finish, flush])

  function allTasks() { return taskSnapshots(taskHistory.current, trial.current?.snapshot() ?? null) }
  function report() { if (flow.current?.stage !== 'experiment' || !recorder.current?.active) send(snapshot()) }
  async function localAction(action: () => void | Promise<void>) {
    if (localBusy.current) return
    localBusy.current = true; setLocalPending(true); error.current = ''
    try {
      if (!storage.ready || !await storage.flush()) throw new Error('端末内保存を確認してください。進行せず記録を保持します。')
      await action()
      if (!await storage.flush()) throw new Error('端末内に保存できませんでした。記録を保持しています。')
      report()
    } catch (cause) {
      error.current = cause instanceof Error ? cause.message : '操作できませんでした。記録は保持しています。'
      if (flow.current?.stage === 'transfer') setTransferState('error')
    } finally { localBusy.current = false; setLocalPending(false) }
  }
  async function checkTransfer() {
    digest.current = null; transferAttempt.current++; setTransferState('checking')
    if (!await storage.flush()) throw new Error('転送前の保存が完了していません。再接続・保存状態を確認してください。')
    const saved = await storage.journal.active()
    if (!saved) throw new Error('保存した記録が見つかりません。端末を更新せず実験者にお知らせください。')
    const disk = readPhoneCheckpoint(saved)
    const current = recorder.current
    const memory = recovered.current ?? (current ? phoneArchiveSchema.parse({ ...phoneHeader(current),
      samples: current.batch(0, MAX_SAMPLES), estimates: current.estimateBatch(0, MAX_SAMPLES) }) : null)
    if (!memory?.completion || memory.metadata.sessionId !== disk.metadata.sessionId) throw new Error('停止した記録と保存データが一致しません。')
    const [memoryHash, diskHash] = await Promise.all([phoneArchiveDigest(memory), phoneArchiveDigest(disk)])
    if (memoryHash !== diskHash) throw new Error('iPhoneの記録と端末内保存の内容が一致しません。記録を残して再確認してください。')
    digest.current = diskHash; setTransferState('waiting'); send(snapshot())
  }
  const preparationDisconnected = useEffectEvent(() => {
    if (!flow.current || recovered.current || !recorder.current?.active || connectionDecision) return
    setConnectionDecision(true)
    updateFlow({ ...flow.current, preparationInterruptions: [...flow.current.preparationInterruptions, performance.now()] })
    if (trial.current && !trial.current.complete) {
      audio.current.cancel(); trial.current.abort(performance.now(), 'connection-during-tutorial'); renderTask()
    }
    void storage.flush()
  })
  useEffect(() => {
    if (['consent', 'tutorial'].includes(phoneFlow?.stage ?? '') && (!connected || !controller)) preparationDisconnected()
  }, [phoneFlow?.stage, connected, controller])
  const verifyRestoredTransfer = useEffectEvent(() => { void localAction(checkTransfer) })
  useEffect(() => {
    if (storage.ready && recovered.current?.phoneFlow?.stage === 'transfer' && !restoredTransfer.current) {
      restoredTransfer.current = true; verifyRestoredTransfer()
    }
  }, [storage.ready, phoneFlow?.stage])
  function acceptConsent() {
    return localAction(() => {
      if (!recorder.current?.active || !flow.current || flow.current.stage !== 'consent' || !linkConfirmed || !connected || !controller || connectionDecision || !snapshot().ready) throw new Error('PCとの同期・センサーの準備を確認してください。')
      updateFlow({ ...flow.current, consentedAtMs: performance.now(), stage: 'tutorial' })
    })
  }
  function nextTutorialPage() {
    return localAction(() => {
      const state = flow.current
      if (!recorder.current?.active || state?.stage !== 'tutorial' || state.tutorialPage >= 2 || !linkConfirmed || !connected || !controller || connectionDecision)
        throw new Error('接続とチュートリアルの進行を確認してください。')
      if (state.tutorialPage === 1 && !audio.current.ready) throw new Error('先に合図音を準備・試聴してください。')
      updateFlow({ ...state, tutorialPage: state.tutorialPage + 1 })
    })
  }
  function continuePreparation() {
    return localAction(() => {
      if (!linkConfirmed || !connected || !controller) throw new Error('PCとの同期を確認してください。')
      const previous = trial.current?.snapshot()
      if (previous?.phase === 'aborted') { taskHistory.current.set(previous.id, previous); trial.current = null; renderTask() }
      setConnectionDecision(false)
    })
  }
  function nextOnPhone() {
    return localAction(() => {
      const current = recorder.current, plan = participant.current, state = flow.current
      if (!current?.active || !plan || state?.stage !== 'experiment') throw new Error('実験の開始・停止状態を確認してください。')
      const step = phoneNextStep(plan, allTasks(), questionnaires.current.snapshot(), state)
      if (step.kind === 'task') startTrial(crypto.randomUUID(), step.taskId, step.mode)
      else if (step.kind === 'survey') {
        const linkedIds = step.target === 'final' ? questionnaires.current.snapshot().filter((run) => run.target !== 'final' && run.phase === 'submitted').map((run) => run.id)
          : conditionTaskIds(allTasks(), step.target)
        questionnaires.current.open(crypto.randomUUID(), current.metadata.sessionId, step.target, linkedIds, performance.now(), allTasks())
        renderSurvey()
      } else throw new Error('直前の課題・動作確認を終了してください。')
    })
  }
  function confirmMovementOnPhone(input: MovementConfirmationInput) {
    return localAction(() => {
      const state = flow.current
      if (!recorder.current?.active || !state || state.stage !== 'experiment' || !validMovementConfirmation(input, allTasks())) throw new Error('完了した本番課題の動作を確認してください。')
      const entry = phoneMovementConfirmationSchema.parse({ ...input, confirmedAtPhoneMs: performance.now() })
      updateFlow({ ...state, confirmations: [...state.confirmations, entry] })
    })
  }
  function beginOnPhone() {
    return localAction(() => {
      if (flow.current?.stage !== 'experiment' || !recorder.current?.active || !audio.current.ready) throw new Error('計測・合図音の準備を確認してください。')
      trial.current?.begin(performance.now(), 'phone'); renderTask()
    })
  }
  async function submitSurvey(id: string) {
    await localAction(async () => {
      if (flow.current && !recorder.current?.active) throw new Error('計測が中断しています。実験者にお知らせください。')
      questionnaires.current.submit(id, performance.now()); renderSurvey()
      const run = questionnaires.current.active
      if (!flow.current || run?.phase !== 'submitted') return
      questionnaires.current.dismiss(); renderSurvey()
      if (run.target === 'final') {
        if (!participant.current || phoneNextStep(participant.current, allTasks(), questionnaires.current.snapshot(), flow.current).kind !== 'done')
          throw new Error('課題・アンケート・動作確認の完了を確認してください。')
        updateFlow({ ...flow.current, stage: 'transfer' }); finish('manual')
        await checkTransfer()
      }
    })
  }
  function retryConnection() {
    reconnect(); setLinkConfirmed(false)
    if (flow.current?.stage === 'transfer') void localAction(checkTransfer)
    else report()
  }
  async function restartOnPhone() {
    if (!window.confirm('実験者に確認してください。今の記録を端末内に保管し、同じ参加者で説明・同意からやり直しますか？')) return
    await localAction(async () => {
      const state = flow.current, plan = participant.current
      if (!state || !plan) throw new Error('やり直す参加者の設定が見つかりません。')
      if (['consent', 'tutorial'].includes(state.stage) && (!connected || !controller || !linkConfirmed)) throw new Error('PCとの同期を確認してから、やり直しを選んでください。')
      finish('manual')
      await storage.archive()
      const next = createPhoneFlow(crypto.randomUUID(), state.sessionId, state.stage === 'transfer' ? '転送完了前に全体のやり直しを選択' : '説明・練習中の通信切断または計測中断によるやり直し')
      recorder.current = new MeasurementRecorder({ sessionId: next.sessionId, startedAt: new Date().toISOString(),
        startedAtMs: performance.now(), timeOriginMs: performance.timeOrigin, userAgent: navigator.userAgent }, estimationConfig)
      recovered.current = null; continuation.current = undefined; taskHistory.current.clear(); trial.current = null
      questionnaires.current = new QuestionnaireBook(); renderSurvey(); renderTask(); setDismissedPracticeId(null)
      digest.current = null; setTransferState(''); setLinkConfirmed(false); setConnectionDecision(false); setRecoveryMessage(''); restoredTransfer.current = false
      updateFlow(next)
      if (enabled.current && source.current?.getPermission() === 'granted' && !document.hidden) feed()
      send(snapshot())
    })
  }

  function practiceAvailable() {
    const all = new Map([...(continuation.current?.tasks ?? []).filter((t) => t.purpose !== 'practice' || t.phase === 'complete').map((t) => [t.id, t] as const), ...taskHistory.current])
    return storage.ready && !storage.error && !recovered.current && audio.current.ready && connected && controller && !connectionDecision
      && (!flow.current || (flow.current.stage === 'tutorial' && flow.current.tutorialPage === 2 && linkConfirmed)) && canStartPractice(recorder.current?.active ?? false, taskSnapshots(all, trial.current?.snapshot() ?? null), questionnaires.current.answering)
  }
  function startTrial(runId: string, taskId: TrialTaskId, mode: ExperimentMode) {
    const current = recorder.current
    if (!current) return
    audio.current.cancel()
    const previous = trial.current?.snapshot()
    if (previous) taskHistory.current.set(previous.id, previous)
    questionnaires.current.dismiss(); renderSurvey(); setDismissedPracticeId(null)
    const previousRun = previous ?? continuation.current?.tasks.at(-1)
    trial.current = new TransitTrial(runId, current.metadata.sessionId, taskId, performance.now(), mode, {
      kind: previousRun?.kind, timing: previousRun?.timing, originalSessionId: continuation.current?.previousSessionIds[0],
    })
    trial.current.updateAdaptation(current.latestEstimate, performance.now())
    renderTask()
  }
  function startPractice() {
    if (!practiceAvailable()) return
    startTrial(crypto.randomUUID(), 'P1', 'automatic')
    send(snapshot()); void storage.flush()
  }
  function practiceAction(action: 'begin' | 'confirm') {
    if (flow.current && (connectionDecision || !connected || !controller || localBusy.current)) return
    if (trial.current?.snapshot().purpose !== 'practice') return
    if (action === 'begin' && !audio.current.ready) { error.current = '合図音を準備してください。'; return }
    if (action === 'begin') trial.current.begin(performance.now())
    else trial.current.confirmStopped(performance.now())
    renderTask(); send(snapshot())
  }
  function closePractice() {
    const current = trial.current?.snapshot()
    if (current?.purpose !== 'practice' || !trial.current?.complete) return
    setDismissedPracticeId(current.id)
    if (flow.current?.stage === 'tutorial' && recorder.current?.active && connected && controller && !connectionDecision) {
      updateFlow({ ...flow.current, stage: 'experiment' }); void storage.flush(); send(snapshot())
    }
  }
  function confirmStoppedOnPhone() {
    trial.current?.confirmStopped(performance.now(), 'phone')
    renderTask(); report(); void storage.flush()
  }
  function stopOnPhone() { finish('manual'); send(snapshot()); void storage.flush() }
  async function enable() {
    const token = ++generation.current
    setPending(true)
    try {
      source.current ??= createBrowserMotionSource()
      const [permission] = await Promise.all([source.current.requestPermission(), audio.current.prepare()])
      if (token !== generation.current) return
      if (permission !== 'granted') throw new Error('センサーの利用が許可されませんでした。')
      if (document.hidden) throw new Error('画面を表示してから操作してください。')
      enabled.current = true; setAudioReady(true); error.current = ''; feed()
    } catch (cause) { error.current = cause instanceof Error ? cause.message : '取得を開始できませんでした。' }
    finally { if (token === generation.current) setPending(false) }
  }
  async function prepareAudio() {
    try { await audio.current.prepare(); setAudioReady(true); error.current = '' }
    catch (cause) { setAudioReady(false); error.current = cause instanceof Error ? cause.message : '合図音を準備できませんでした。' }
    setStatus(error.current || '合図音を試聴しました。音量を確認してください。')
    send(snapshot())
  }
  const audioControls = <div className="audio-check">
      <p><strong>合図音</strong> <span className={audioReady ? 'success' : 'notice'}>{audioReady ? '準備済み' : '未準備'}</span></p>
      <p>短い音で次の動作に切り替え、長い音が鳴ったら安全に立ち止まってください。</p>
      <button onClick={() => void prepareAudio()}>合図音を準備・試聴</button>
      {error.current && <p className="error" role="alert">{error.current}</p>}
    </div>
  const localActive = recorder.current?.active ?? false
  const localTasks = allTasks()
  const localStep = phoneFlow && participant.current ? phoneNextStep(participant.current, localTasks, questionnaires.current.snapshot(), phoneFlow) : null
  const displayTask = taskRun && taskRun.id !== dismissedPracticeId && (!phoneFlow || (!recovered.current && localActive && !connectionDecision
    && ['tutorial', 'experiment'].includes(phoneFlow.stage) && !['complete', 'aborted'].includes(taskRun.phase)))
  const displaySurvey = survey && (!phoneFlow || (phoneFlow.stage === 'experiment' && localActive && !connectionDecision))
  return <section>
    {phoneFlow && !displayTask && !displaySurvey && <PhoneFlowScreen key={phoneFlow.sessionId} flow={phoneFlow} step={localStep} tasks={localTasks}
      participantId={participant.current?.participantId ?? ''} connected={connected && controller && linkConfirmed}
      interrupted={connectionDecision} recovered={!!recovered.current} stopped={!localActive} pending={localPending || pending}
      error={storage.error || error.current} transferState={transferState} audioControls={audioControls}
      sensorReady={enabled.current && audioReady && streaming.current && events.current.valid > 0 && !document.hidden} onPrepare={() => void enable()}
      onAccept={() => void acceptConsent()} onTutorialNext={() => void nextTutorialPage()} onPractice={() => void localAction(startPractice)}
      onPracticeComplete={() => void localAction(closePractice)} onNext={() => void nextOnPhone()}
      onReconnect={retryConnection} onResume={() => void continuePreparation()} onRestart={() => void restartOnPhone()}
      onConfirmMovement={(input) => void confirmMovementOnPhone(input)} onStop={stopOnPhone} />}
    {displaySurvey && survey && <QuestionnaireScreen key={survey.id} run={survey} onPresent={presentSurvey}
      error={storage.error || error.current} pending={localPending} onStop={phoneFlow ? stopOnPhone : undefined}
      onAnswer={(id, item, value) => { questionnaires.current.answer(id, item, value, performance.now()); renderSurvey(); report() }}
      onSubmit={(id) => void submitSurvey(id)} />}
    {!displaySurvey && displayTask && taskRun && <TransitTaskScreen key={taskRun.id} run={taskRun} onPresent={presentTask} onAdvance={advanceTask}
      audioControls={audioControls}
      error={storage.error || error.current} pending={localPending}
      onBegin={phoneFlow ? () => void beginOnPhone() : undefined}
      onPracticeBegin={() => practiceAction('begin')} onPracticeConfirm={() => practiceAction('confirm')} onPracticeFinish={closePractice}
      onConfirmStopped={confirmStoppedOnPhone}
      onShowDetails={(index) => { trial.current?.showDetails(index, performance.now()); renderTask(); report() }}
      onSelectTrain={(index) => { trial.current?.select(index, performance.now()); renderTask(); report() }}
      onAnswer={(value) => { trial.current?.answer(value, performance.now()); renderTask(); report(); void storage.flush() }}
      onTap={(x, y, action) => { trial.current?.tap(performance.now(), x, y, action) }}
      onStop={stopOnPhone} />}
    {!phoneFlow && !survey && (!taskRun || taskRun.id === dismissedPracticeId) && <section className="phone-setup">
      <PhonePreparation connected={connected && controller} storageReady={storage.ready} storageError={storage.error}
        sensorReady={enabled.current && events.current.valid > 0 && !document.hidden} pending={pending}
        recording={recorder.current?.active ?? false} stopped={!!recorder.current?.completion} recovered={!!recovered.current}
        practiceReady={practiceAvailable()} practiceFinished={dismissedPracticeId !== null || !!continuation.current?.tasks.some((t) => t.purpose === 'practice' && t.phase === 'complete')} resuming={!!continuation.current}
        onEnable={() => void enable()} onPractice={startPractice} />
      {audioControls}
      {recoveryMessage && <p className="notice">{recoveryMessage}</p>}
      {storage.error && <p className="error" role="alert">{storage.error}</p>}
      {error.current && <p className="error" role="alert">{error.current}</p>}
      <details className="phone-details">
        <summary>接続・保存の詳細（実験者用）</summary>
        <p>PC接続：{connected && controller ? '接続済み' : '待機中'}</p>
        <p>端末内保存：{storage.ready ? '準備済み' : '準備中'} ／ 最終保存：{storage.savedAt || '未保存'}</p>
        <p>{status}</p>
        <p>記録は端末内にも順次保存します。データの確認・保存・出力はPCで行います。</p>
      </details>
      <p><small>画面を開いたままにし、再読み込みしないでください。</small></p>
      <button className="stop-recording" onClick={() => { finish('manual'); send(snapshot()) }}>緊急停止</button>
    </section>}
  </section>
}
