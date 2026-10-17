import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { createBrowserMotionSource } from '@physical-adaptive/device-motion'
import type { DeviceMotionSource, MotionSample } from '@physical-adaptive/device-motion'
import { hasCompleteAcceleration, MeasurementRecorder, MAX_SAMPLES } from './recording'
import { BATCH_SIZE } from './recording-schema'
import type { StopReason } from './recording'
import type { Identity, Message, PhoneStatus } from './protocol'
import { useMeasurementTransport } from './transport'
import { useCheckpoint } from './useCheckpoint'
import { readPhoneCheckpoint } from './phone-checkpoint'
import type { PhoneArchive } from './phone-checkpoint'
import type { Participant } from './management'
import type { Continuation } from './continuation'
import { assessableTasks, emptyManagement } from './management'
import { estimationConfig } from './estimation'
import TransitTaskScreen from './TransitTaskScreen'
import QuestionnaireScreen from './QuestionnaireScreen'
import PhonePreparation from './PhonePreparation'
import { QuestionnaireBook } from './questionnaire'
import { TransitTrial, canStartPractice, taskSnapshots } from './tasks'
import type { PresentationMetrics, RenderedTaskContext } from './adaptation'
import type { TaskRun } from './tasks'
import type { SurveyRun } from './questionnaire'

export default function Sensor({ identity }: { identity: Identity }) {
  const source = useRef<DeviceMotionSource | null>(null)
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
    if (current.present(performance.now(), metrics, rendered)) renderTask()
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
  const [status, setStatus] = useState('貸出前にセンサーの利用を許可してください。')
  const storage = useCheckpoint('sensor', identity.room, {
    snapshot: (sampleStart, estimateStart) => {
      const current = recorder.current
      if (!current || recovered.current) return null
      return { sessionId: current.metadata.sessionId, sampleStart, estimateStart,
        samples: current.batch(sampleStart, MAX_SAMPLES), estimates: current.estimateBatch(estimateStart, MAX_SAMPLES),
        header: { ...(continuation.current ? { continuation: continuation.current } : {}), format: 'physical-adaptive-phone-checkpoint', version: 1,
          metadata: current.metadata, participant: participant.current, completion: current.completion,
          config: current.estimationConfig, savedThroughMs: performance.now(), tasks: taskSnapshots(taskHistory.current, trial.current?.snapshot() ?? null), questionnaires: questionnaires.current.snapshot() } }
    },
    restore: (saved) => {
      recovered.current = readPhoneCheckpoint(saved)
      participant.current = recovered.current.participant
      continuation.current = recovered.current.continuation
      setRecoveryMessage('更新前の保存データを復旧しました。計測は中断扱いです。PCでデータを回収し、「同じ参加者の続きから再開」または「実験を終了して保存」を選んでください。')
    },
  })

  function finish(reason: StopReason) {
    trial.current?.abort(recorder.current?.completion?.endedAtMs ?? performance.now(), reason)
    renderTask()
    recorder.current?.stop(performance.now(), reason)
    source.current?.stop(); streaming.current = false
  }
  function feed() {
    if (streaming.current || !source.current) return
    source.current.start((sample) => {
      latest.current = sample; events.current.total++
      if (hasCompleteAcceleration(sample)) events.current.valid++
      recorder.current?.append(sample)
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
      return { ...(archive.continuation ? { continuation: archive.continuation } : {}), type: 'status', streaming: false, visible: !document.hidden, ready: false, permission: 'prompt', error: error.current,
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
      type: 'status', participant: participant.current, recovered: false, recoverySavedThroughMs: null,
      storage: { ready: storage.ready, savedAt: storage.savedAt, error: storage.error, restored: storage.restored }, streaming: streaming.current, visible: !document.hidden, ready: enabled.current && events.current.valid > 0 && !document.hidden,
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
  async function receive(message: Message, receivedAtMs: number) {
    if (message.type === 'clock-probe') {
      if (!recovered.current && recorder.current?.metadata.sessionId === message.sessionId) send({ type: 'clock-reply',
        sessionId: message.sessionId, probeId: message.probeId, phoneReceivedAtMs: receivedAtMs,
        phoneTimeOriginMs: performance.timeOrigin, phoneSentAtMs: performance.now() })
      return
    }
    try {
      const archive = recovered.current
      if (archive) {
        if ('sessionId' in message && message.sessionId === archive.metadata.sessionId) {
          if (message.type === 'pull-tasks') send({ type: 'task-history', sessionId: message.sessionId, tasks: archive.tasks })
          if (message.type === 'pull') send({ type: 'batch', sessionId: message.sessionId, startIndex: message.startIndex, samples: archive.samples.slice(message.startIndex, message.startIndex + BATCH_SIZE) })
          if (message.type === 'pull-estimates') send({ type: 'estimates', sessionId: message.sessionId, startIndex: message.startIndex, estimates: archive.estimates.slice(message.startIndex, message.startIndex + BATCH_SIZE) })
          if (message.type === 'clear' && !clearing.current) {
            clearing.current = true
            try { await storage.archive(); recovered.current = null; participant.current = null; continuation.current = undefined; setRecoveryMessage('') }
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
        questionnaires.current = new QuestionnaireBook(message.continuation)
        recorder.current = new MeasurementRecorder({ sessionId: message.sessionId,
          startedAt: new Date().toISOString(), startedAtMs: performance.now(),
          timeOriginMs: performance.timeOrigin, userAgent: navigator.userAgent }, estimationConfig)
        try { feed() } catch (cause) { recorder.current = null; throw cause }
        error.current = ''
      } else if ('sessionId' in message && current && message.sessionId === current.metadata.sessionId) {
        if (message.type === 'pull-tasks') {
          send({ type: 'task-history', sessionId: message.sessionId, tasks: taskSnapshots(taskHistory.current, trial.current?.snapshot() ?? null) })
        }
        if (message.type === 'stop') finish('manual')
        if (message.type === 'clear') {
          if (current.active) throw new Error('記録停止後に消去してください。')
          if (questionnaires.current.answering && !message.forContinuation) throw new Error('アンケートの回答が途中です。送信してから消去してください。')
          if (clearing.current) return
          clearing.current = true
          try { await storage.archive() } finally { clearing.current = false }
          recorder.current = null; participant.current = null; continuation.current = undefined; trial.current = null; taskHistory.current.clear();
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
            const previous = trial.current?.snapshot()
            if (previous) taskHistory.current.set(previous.id, previous)
            questionnaires.current.dismiss(); renderSurvey()
            trial.current = new TransitTrial(message.runId, message.sessionId, message.taskId, performance.now(), message.mode)
            trial.current.updateAdaptation(current.latestEstimate, performance.now())
            renderTask(); error.current = ''
          }
        }
        if (message.type === 'task-abort' && trial.current?.snapshot().id === message.runId) {
          trial.current.abort(performance.now(), message.reason); renderTask(); error.current = ''
        }
        if (message.type === 'task-begin' && trial.current?.snapshot().id === message.runId) {
          if (!current.active) throw new Error('センサー記録中に計測を開始してください。')
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
  const send = useMeasurementTransport(identity, {
    message: receive,
    presence: (presence) => {
      setController(presence.controller)
      if (presence.error) error.current = presence.error
      send(snapshot())
    },
    connection: setConnected,
    error: (message) => { error.current = message },
  })

  // Read committed storage state without restarting the sensor lifecycle on each save.
  const readStatus = useEffectEvent(snapshot)
  useEffect(() => {
    const generationRef = generation
    const timer = window.setInterval(() => {
      recorder.current?.evaluate(performance.now())
      if (recorder.current?.completion?.stopReason === 'capacity') finish('capacity')
      advanceTask()
      const current = readStatus()
      send(current)
      setStatus(error.current || (recorder.current?.active ? '記録中です。操作はPCで行います。'
        : current.ready ? '準備済みです。PCから記録を開始できます。' : 'センサーの許可・受信を確認してください。'))
    }, estimationConfig.updateIntervalMs)
    const hidden = () => {
      if (!document.hidden) return
      finish('page-hidden'); enabled.current = false; void storage.flush()
      send(readStatus())
    }
    const unload = (event: BeforeUnloadEvent) => { if (recorder.current) event.preventDefault() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', unload)
    return () => {
      generationRef.current++; source.current?.stop(); streaming.current = false
      clearInterval(timer); document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', unload)
    }
  }, [send, advanceTask])

  function practiceAvailable() {
    const all = new Map([...(continuation.current?.tasks ?? []).filter((t) => t.purpose !== 'practice' || t.phase === 'complete').map((t) => [t.id, t] as const), ...taskHistory.current])
    return storage.ready && !storage.error && !recovered.current && connected && controller && canStartPractice(recorder.current?.active ?? false, taskSnapshots(all, trial.current?.snapshot() ?? null), questionnaires.current.answering)
  }
  function startPractice() {
    const current = recorder.current
    if (!current || !practiceAvailable()) return
    const previous = trial.current?.snapshot()
    if (previous) taskHistory.current.set(previous.id, previous)
    questionnaires.current.dismiss(); renderSurvey(); setDismissedPracticeId(null)
    trial.current = new TransitTrial(crypto.randomUUID(), current.metadata.sessionId, 'P1', performance.now(), 'automatic')
    trial.current.updateAdaptation(current.latestEstimate, performance.now())
    renderTask(); send(snapshot()); void storage.flush()
  }
  function practiceAction(action: 'begin' | 'confirm') {
    if (trial.current?.snapshot().purpose !== 'practice') return
    if (action === 'begin') trial.current.begin(performance.now())
    else trial.current.confirmStopped(performance.now())
    renderTask(); send(snapshot())
  }
  function closePractice() {
    const current = trial.current?.snapshot()
    if (current?.purpose !== 'practice' || !trial.current?.complete) return
    setDismissedPracticeId(current.id); send(snapshot())
  }
  async function enable() {
    const token = ++generation.current
    setPending(true)
    try {
      source.current ??= createBrowserMotionSource()
      const permission = await source.current.requestPermission()
      if (token !== generation.current) return
      if (permission !== 'granted') throw new Error('センサーの利用が許可されませんでした。')
      if (document.hidden) throw new Error('画面を表示してから操作してください。')
      enabled.current = true; error.current = ''; feed()
    } catch (cause) { error.current = cause instanceof Error ? cause.message : '取得を開始できませんでした。' }
    finally { if (token === generation.current) setPending(false) }
  }
  return <section>
    {survey && <QuestionnaireScreen key={survey.id} run={survey} onPresent={presentSurvey}
      onAnswer={(id, item, value) => { questionnaires.current.answer(id, item, value, performance.now()); renderSurvey(); send(snapshot()) }}
      onSubmit={(id) => { questionnaires.current.submit(id, performance.now()); renderSurvey(); send(snapshot()); void storage.flush() }} />}
    {!survey && taskRun && taskRun.id !== dismissedPracticeId && <TransitTaskScreen key={taskRun.id} run={taskRun} onPresent={presentTask} onAdvance={advanceTask}
      onPracticeBegin={() => practiceAction('begin')} onPracticeConfirm={() => practiceAction('confirm')} onPracticeFinish={closePractice}
      onSelectTrain={(index) => { trial.current?.select(index, performance.now()); renderTask(); send(snapshot()) }}
      onAnswer={(value) => { trial.current?.answer(value, performance.now()); renderTask(); send(snapshot()); void storage.flush() }}
      onTap={(x, y, action) => { trial.current?.tap(performance.now(), x, y, action) }}
      onStop={() => { finish('manual'); send(snapshot()) }} />}
    {!survey && (!taskRun || taskRun.id === dismissedPracticeId) && <>
      <PhonePreparation connected={connected && controller} storageReady={storage.ready} storageError={storage.error}
        sensorReady={enabled.current && events.current.valid > 0 && !document.hidden} pending={pending}
        recording={recorder.current?.active ?? false} stopped={!!recorder.current?.completion} recovered={!!recovered.current}
        practiceReady={practiceAvailable()} practiceFinished={dismissedPracticeId !== null || !!continuation.current?.tasks.some((t) => t.purpose === 'practice' && t.phase === 'complete')} resuming={!!continuation.current}
        onEnable={() => void enable()} onPractice={startPractice} />
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
    </>}
  </section>
}
