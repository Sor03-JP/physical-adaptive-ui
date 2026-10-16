import { useEffect, useRef, useState } from 'react'
import { atom, useAtom } from 'jotai'
import SavedRecording from './SavedRecording'
import ParticipantManager from './ParticipantManager'
import ExperimentProgress, { experimentProgress } from './ExperimentProgress'
import StoragePanel from './StoragePanel'
import { useCheckpoint } from './useCheckpoint'
import { nextStep, emptyManagement } from './management'
import type { Participant, Failure } from './management'
import { downloadText } from './download'
import { writeQuestionnaireCsv } from './questionnaire-csv'
import FeaturePreview from './FeaturePreview'
import TaskController from './TaskController'
import QuestionnaireController from './QuestionnaireController'
import type { SurveyTarget } from './questionnaire'
import ObservationPanel, { canRecordObservation } from './ObservationPanel'
import type { ObservationKind, ResearchEvent } from './research-log'
import { stateLabels } from './adaptation'
import type { ExperimentMode } from './adaptation'
import type { TaskId } from './tasks'
import type { Identity, Message, PhoneStatus, Presence } from './protocol'
import { useMeasurementTransport } from './transport'
import { MAX_SAMPLES } from './recording'
import { TransferCollector, writeTransfer } from './transfer'

type Command = Extract<Message, { type: 'start' | 'stop' | 'clear' | 'task-start' | 'task-begin' | 'task-answer' | 'survey-open' | 'task-abort' }>
const panelAtom = atom({ phone: null as PhoneStatus | null, received: 0, estimates: 0, valid: 0, complete: false, pending: '' })
const number = (value: number | null | undefined) => value == null ? '—' : value.toFixed(3)
const seconds = (value: number) => (value / 1000).toFixed(1)

export default function Controller({ identity }: { identity: Identity }) {
  const [panel, setPanel] = useAtom(panelAtom)
  const [connected, setConnected] = useState(false)
  const [presence, setPresence] = useState<Presence>({ controller: false, sensor: false, sensorUrls: [], error: '' })
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [hideInference, setHideInference] = useState(true)
  const collector = useRef<TransferCollector | null>(null)
  const phone = useRef<PhoneStatus | null>(null)
  const command = useRef<Command | null>(null)
  const verified = useRef(false)
  const clearing = useRef(false)
  const historySession = useRef('')
  const managementSaving = useRef(false)
  const details = useRef<HTMLDetailsElement>(null)
  const [selectedParticipant, setSelectedParticipant] = useState<Participant | null>(null)
  const [exports, setExports] = useState({ json: false, csv: false })
  function controllerNow() { return performance.now() + performance.timeOrigin - (collector.current?.controllerTimeOriginMs ?? performance.timeOrigin) }
  const storage = useCheckpoint('controller', identity.room, {
    snapshot: (sampleStart, estimateStart) => collector.current?.checkpoint(sampleStart, estimateStart) ?? null,
    restore: (saved) => {
      collector.current = TransferCollector.restore(saved, performance.timeOrigin, performance.now())
      setSelectedParticipant(collector.current.management.participant)
      if (!collector.current.recovery) collector.current.research.begin(collector.current.research.hasStartCalibration ? 'manual' : 'start', controllerNow())
      verified.current = false; refresh()
    },
  })

  function refresh() {
    const current = collector.current
    if (current && phone.current?.metadata?.sessionId === current.metadata.sessionId && phone.current.completion && !current.recovery && !current.research.busy
      && !current.research.snapshot().rounds.some((r) => r.purpose === 'end')) {
      current.research.begin('end', controllerNow()); verified.current = false
    }
    setPanel({ phone: phone.current, received: current?.count ?? 0,
      estimates: current?.estimateCount ?? 0,
      valid: current?.summary().completeAccelerationCount ?? 0,
      complete: current?.complete ?? false, pending: command.current?.type ?? (managementSaving.current ? 'saving' : '') })
  }
  function receive(packet: Message, receivedAtMs: number) {
    if (!storage.ready) return
    receivedAtMs += performance.timeOrigin - (collector.current?.controllerTimeOriginMs ?? performance.timeOrigin)
    if (packet.type === 'clock-reply') {
      if (collector.current?.research.receive(packet, receivedAtMs)) verified.current = false
    } else if (packet.type === 'status') {
      phone.current = packet
      const metadata = packet.metadata
      if (metadata) {
        if (collector.current && collector.current.metadata.sessionId !== metadata.sessionId) {
          setError('別の記録を受信しました。現在のデータを保存してから、接続先を確認してください。'); return
        }
        if (!collector.current) {
          collector.current = new TransferCollector(metadata, performance.timeOrigin, packet.estimationConfig)
          if (!packet.recovered) collector.current.research.begin('start', receivedAtMs)
        }
        collector.current.setParticipant(packet.participant)
        if (packet.recovered) collector.current.recovery ??= { phoneSavedThroughMs: packet.recoverySavedThroughMs!, detectedAt: new Date().toISOString() }
        packet.recoveredTasks.forEach((task) => collector.current!.updateTask(task))
        collector.current.updateStatus(packet.count, packet.completion, packet.estimateCount)
        if (collector.current.updateTask(packet.taskRun)) verified.current = false
        if (collector.current.updateQuestionnaires(packet.questionnaires)) verified.current = false
      }
      const pending = command.current
      if (pending?.type === 'start' && metadata?.sessionId === pending.sessionId) command.current = null
      if (pending?.type === 'stop' && metadata?.sessionId === pending.sessionId && packet.completion) command.current = null
      if (pending?.type === 'task-abort' && packet.taskRun?.id === pending.runId && packet.taskRun.phase === 'aborted') command.current = null
      if (pending?.type === 'survey-open' && packet.questionnaires.some((r) => r.id === pending.surveyId)) command.current = null
      if (pending?.type === 'task-start' && packet.taskRun?.id === pending.runId) command.current = null
      if (pending?.type === 'task-begin' && packet.taskRun?.id === pending.runId && packet.taskRun.phase !== 'briefing') command.current = null
      if (pending?.type === 'task-answer' && packet.taskRun?.id === pending.runId && packet.taskRun.phase !== 'waiting-stop') command.current = null
      if (pending?.type === 'clear' && metadata === null && !clearing.current) {
        clearing.current = true
        void storage.archive().then(() => {
          collector.current = null; command.current = null; verified.current = false
          setSelectedParticipant(null); setExports({ json: false, csv: false }); refresh()
        }).catch(() => {
          command.current = null; setError('保存済み記録の整理に失敗しました。現在の記録は保持しています。'); refresh()
        }).finally(() => { clearing.current = false })
      }
      if (packet.error) {
        setError(packet.error)
        if (pending?.type === 'start' && metadata === null) command.current = null
        if (pending?.type === 'task-abort' || pending?.type === 'survey-open' || pending?.type === 'task-start' || pending?.type === 'task-begin' || pending?.type === 'task-answer') command.current = null
      }
    } else if (packet.type === 'task-history' && packet.sessionId === collector.current?.metadata.sessionId) {
      packet.tasks.forEach((task) => { if (collector.current!.updateTask(task)) verified.current = false })
      historySession.current = packet.sessionId
    } else if (packet.type === 'batch' && packet.sessionId === collector.current?.metadata.sessionId) {
      const current = collector.current
      const accepted = current.receive(packet.startIndex, packet.samples, receivedAtMs)
      if (accepted) verified.current = false
    } else if (packet.type === 'estimates' && packet.sessionId === collector.current?.metadata.sessionId) {
      if (collector.current.receiveEstimates(packet.startIndex, packet.estimates)) verified.current = false
    }
    refresh()
  }
  const send = useMeasurementTransport(identity, { message: receive, presence: setPresence, connection: setConnected, error: setError })
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (command.current) send(command.current)
      const current = collector.current
      const status = phone.current
      if (current) {
        const probe = current.research.poll(controllerNow())
        if (probe) send(probe)
        if (current.research.busy || probe) verified.current = false
        refresh()
      }
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && historySession.current !== current.metadata.sessionId) {
        send({ type: 'pull-tasks', sessionId: current.metadata.sessionId })
      }
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && current.count < status.count) {
        send({ type: 'pull', sessionId: current.metadata.sessionId, startIndex: current.count })
      }
      if (current && status?.metadata?.sessionId === current.metadata.sessionId && current.estimateCount < status.estimateCount) {
        send({ type: 'pull-estimates', sessionId: current.metadata.sessionId, startIndex: current.estimateCount })
      }
    }, 200)
    const unload = (event: BeforeUnloadEvent) => {
      if (collector.current && !verified.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', unload)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload) }
  }, [send])

  function start() {
    if (!selectedParticipant || !storage.ready || storage.error || !phone.current?.storage.ready || phone.current.storage.error
      || collector.current || command.current || !connected || !presence.sensor || !phone.current?.ready) return
    verified.current = false; setError(''); setMessage('')
    setExports({ json: false, csv: false })
    command.current = { type: 'start', sessionId: crypto.randomUUID(), participant: selectedParticipant }
    send(command.current); refresh()
  }
  function stop() {
    if (!collector.current || command.current) return
    command.current = { type: 'stop', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh()
  }
  function recordResearch(kind: ResearchEvent['kind'], value: ObservationKind) {
    const current = collector.current
    if (!current || phone.current?.completion || phone.current?.metadata?.sessionId !== current.metadata.sessionId) return
    try {
      const run = phone.current.taskRun
      const questionnaire = current.surveyRuns.find((r) => r.phase === 'answering')
      current.research.record({ kind, value, controllerAtMs: controllerNow(), taskRunId: run?.id ?? null, reportedPhase: questionnaire ? `questionnaire:${questionnaire.target}` : run?.phase ?? null })
      verified.current = false; refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '観察を記録できませんでした。') }
  }
  function calibrate() {
    const current = collector.current
    if (!current || current.research.busy || !connected || !presence.sensor) return
    current.research.begin(phone.current?.completion ? 'end' : current.research.hasStartCalibration ? 'manual' : 'start', controllerNow())
    verified.current = false; refresh()
  }
  function recordManualResearch(kind: ResearchEvent['kind'], value: ObservationKind) {
    if (!canRecordObservation(phone.current?.taskRun?.phase ?? null,
      collector.current?.surveyRuns.some((survey) => survey.phase === 'answering') ?? false)) return
    recordResearch(kind, value)
  }
  function openSurvey(target: SurveyTarget, linkedIds: string[]) {
    const current = collector.current
    if (!current || command.current || !connected || !presence.sensor || reading || current.research.busy || current.recovery) return
    const participant = current.management.participant
    const step = participant ? nextStep(participant, current.taskRuns, current.surveyRuns, current.management) : null
    if (step && (step.kind !== 'survey' || step.target !== target)) { setError('割当済みの順序に従ってアンケートを実施してください。'); return }
    setError(''); verified.current = false
    recordResearch('observation', 'stationary')
    command.current = { type: 'survey-open', sessionId: current.metadata.sessionId, surveyId: crypto.randomUUID(), target, linkedIds }
    send(command.current); refresh()
  }
  function startTask(taskId: TaskId, mode: ExperimentMode) {
    const current = collector.current
    if (!current || command.current || !phone.current?.metadata || phone.current.completion || !connected || !presence.sensor) return
    if (!storage.savedAt || storage.error || !phone.current.storage.savedAt || phone.current.storage.error
      || !current.research.hasStartCalibration || current.research.busy || current.recovery || current.surveyRuns.some((r) => r.phase === 'answering')) return
    const participant = current.management.participant
    if (participant) {
      const step = nextStep(participant, current.taskRuns, current.surveyRuns, current.management)
      if (step.kind !== 'task' || step.taskId !== taskId || step.mode !== mode) { setError('割当済みの次の課題を実施してください。'); return }
      if (current.taskRuns.some((t) => t.purpose === 'main' && t.mode === mode && t.taskId === taskId)) { setError('同じ課題の再実施は、技術的不成立・再実施欄で記録してください。'); return }
    }
    setError(''); verified.current = false
    command.current = { type: 'task-start', sessionId: current.metadata.sessionId, runId: crypto.randomUUID(), taskId, mode }
    send(command.current); refresh()
  }
  function markFailure(failure: Omit<Failure, 'recordedAtControllerMs'>) {
    const current = collector.current
    if (!current || command.current || current.recovery) return
    try {
      current.markFailure({ ...failure, recordedAtControllerMs: controllerNow() }); verified.current = false
      const task = current.taskRuns.find((t) => t.id === failure.originalRunId)!
      if (!['complete', 'aborted'].includes(task.phase)) {
        command.current = { type: 'task-abort', sessionId: current.metadata.sessionId, runId: task.id, reason: failure.reason }
        send(command.current)
      }
      setError(''); refresh(); void storage.flush()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '不成立を記録できませんでした。') }
  }
  async function retryTask(originalRunId: string) {
    const current = collector.current
    if (!current || command.current || managementSaving.current || unavailable || !active || current.recovery || current.research.busy
      || historySession.current !== current.metadata.sessionId
      || !current.research.hasStartCalibration || storage.error || !storage.savedAt || phone.current?.storage.error
      || !phone.current?.storage.savedAt || current.taskRuns.some((t) => !['complete', 'aborted'].includes(t.phase))) return
    try {
      const original = current.taskRuns.find((t) => t.id === originalRunId)!
      const failure = current.management.failures.find((f) => f.originalRunId === originalRunId)
      if (!failure || current.surveyRuns.some((r) => r.phase === 'answering')) throw new Error('不成立理由を記録し、現在の回答を終了してください。')
      const existing = current.management.retries.find((r) => r.originalRunId === originalRunId)
      if (existing && current.taskRuns.some((t) => t.id === existing.retryRunId)) throw new Error('この課題は再実施済みです。')
      const runId = existing?.retryRunId ?? crypto.randomUUID()
      if (!existing) current.requestRetry({ ...failure, retryRunId: runId, consentConfirmed: true, requestedAtControllerMs: controllerNow() })
      managementSaving.current = true; verified.current = false; refresh()
      if (!await storage.flush()) throw new Error('再実施の対応を保存できませんでした。保存エラーを解消してから、記録済みの要求を送信してください。')
      command.current = { type: 'task-start', sessionId: current.metadata.sessionId, runId, taskId: original.taskId as TaskId, mode: original.mode }
      setError(''); send(command.current)

    } catch (cause) { setError(cause instanceof Error ? cause.message : '再実施できませんでした。') }
    finally { managementSaving.current = false; refresh() }
  }
  function beginTask() {
    const run = phone.current?.taskRun
    if (!run || run.phase !== 'briefing' || run.briefingShownAtMs === null || command.current || collector.current?.research.busy) return
    command.current = { type: 'task-begin', sessionId: run.sessionId, runId: run.id }
    send(command.current); refresh()
  }
  function confirmStopped() {
    const run = phone.current?.taskRun
    if (!run || run.phase !== 'waiting-stop' || command.current) return
    recordResearch('observation', 'stationary')
    command.current = { type: 'task-answer', sessionId: run.sessionId, runId: run.id }
    send(command.current); refresh()
  }
  function clear() {
    if ((!collector.current?.complete && !collector.current?.recovery) || command.current || collector.current!.research.busy || (!collector.current!.recovery && collector.current!.surveyRuns.some((r) => r.phase === 'answering'))) return
    if (!verified.current && !window.confirm('現在の記録を終了し、次の計測へ進みます。必要なJSONを保存しましたか？')) return
    command.current = { type: 'clear', sessionId: collector.current.metadata.sessionId }
    send(command.current); refresh(); setMessage('')
  }
  function download() {
    if (!collector.current || collector.current.research.busy) return
    try {
      const data = collector.current.export()
      downloadText(writeTransfer(data), `${data.management.participant?.participantId ?? 'unassigned'}_${data.metadata.sessionId}${data.complete && !data.recovery ? '' : '-partial'}.json`, 'application/json')
      setExports((s) => ({ ...s, json: true }))
      setError(''); setMessage(data.complete ? `JSON出力を開始しました。アンケートは${data.questionnaires.filter((r) => r.phase === 'submitted').length}件回答済み、${data.questionnaires.filter((r) => r.phase === 'answering').length}件回答途中です。保存ファイルをPCで読み戻して確認してください。`
        : '途中データを出力しました。停止確認・全件受信が完了したファイルではありません。')
    } catch { setError('出力できませんでした。記録は保持しています。') }
  }

  function downloadQuestionnaires() {
    const current = collector.current
    if (!current || reading || !current.surveyRuns.length) return
    try {
      downloadText(writeQuestionnaireCsv(current.surveyRuns, current.management.participant), `${current.management.participant?.participantId ?? 'unassigned'}_${current.metadata.sessionId}_questionnaires.csv`, 'text/csv;charset=utf-8')
      setExports((s) => ({ ...s, csv: true }))
      setError(''); setMessage('アンケートCSVの出力を開始しました。1設問1行で、回答途中も含みます。センサーを含む全記録はJSONで保存してください。')
    } catch { setError('アンケートCSVを出力できませんでした。記録は保持しています。') }
  }

  const status = panel.phone
  const latest = status?.latest
  const estimate = status?.latestEstimate
  const active = status?.metadata != null && status.completion === null
  const unavailable = !connected || !presence.sensor
  const management = collector.current?.management ?? emptyManagement()
  const participant = management.participant
  const step = participant && collector.current ? nextStep(participant, collector.current.taskRuns, collector.current.surveyRuns, management) : null
  const activeTask = step?.kind === 'active' ? collector.current?.taskRuns.find((t) => t.id === step.runId && t.purpose === 'main') : null
  const planned = step?.kind === 'task' ? step : activeTask ? { taskId: activeTask.taskId as TaskId, mode: activeTask.mode } : null
  const recording = collector.current !== null
  const recovery = !!collector.current?.recovery
  const busy = collector.current?.research.busy ?? false
  const run = status?.taskRun ?? null
  const surveys = collector.current?.surveyRuns ?? []
  const observationActive = active && !recovery && canRecordObservation(run?.phase ?? null, surveys.some((survey) => survey.phase === 'answering'))
  const progress = experimentProgress({ recording, active, recovery, participant, step, run })
  const ready = !unavailable && !!status?.ready && storage.ready && !storage.error && !!status?.storage.ready && !status.storage.error
  const taskDisabled = unavailable || !active || reading || !!storage.error || !storage.savedAt || !status?.storage.savedAt
    || !!status?.storage.error || !collector.current?.research.hasStartCalibration || busy || surveys.some((r) => r.phase === 'answering')
  const canClear = (panel.complete || recovery) && !panel.pending && !reading && !busy && (recovery || !surveys.some((r) => r.phase === 'answering'))
  const showSurvey = active && !recovery && step?.kind === 'survey'
  const waitingForPhone = recording && status?.metadata?.sessionId !== collector.current?.metadata.sessionId
  const requiresRetry = step?.kind === 'task' && !!collector.current?.taskRuns.some((task) => task.purpose === 'main' && task.taskId === step.taskId && task.mode === step.mode)
  const endClock = collector.current?.research.snapshot().rounds.findLast((round) => round.purpose === 'end')
  function showTroubleshooting() { if (details.current) { details.current.open = true; const retryPanel = details.current.querySelector<HTMLDetailsElement>('[data-retry-panel]'); if (retryPanel) retryPanel.open = true; (retryPanel ?? details.current).scrollIntoView({ behavior: 'smooth', block: 'start' }) } }
  const showTask = active && !recovery && (step?.kind === 'task' || (step?.kind === 'active' && run?.purpose === 'main'))
  const progressManager = (<ParticipantManager variant={collector.current ? 'details' : 'setup'} participant={participant} selected={selectedParticipant} onSelect={setSelectedParticipant}
      locked={!!collector.current || !!panel.pending} management={management} tasks={collector.current?.taskRuns ?? []} surveys={collector.current?.surveyRuns ?? []}
      pending={!!panel.pending || unavailable || !!collector.current?.recovery || historySession.current !== collector.current?.metadata.sessionId} onFailure={markFailure} onRetry={retryTask}
      jsonExported={exports.json} csvExported={exports.csv} verified={verified.current} />
  )
  return <>
    <div className="controller-status" aria-label="接続と記録の状態">
      <p>iPhone：<strong>{unavailable ? '未接続' : status?.ready ? '準備済み' : status?.recovered ? '保存データ回収中' : '受信・許可を確認'}</strong>
        <span>端末内保存：{storage.error || status?.storage.error ? 'エラー' : storage.ready && status?.storage.ready ? '準備済み' : '準備中'}</span>
        <span>{participant ? `参加者 ${participant.participantId}` : '参加者未選択'} ／ {active ? '記録中' : recording ? '停止中' : '開始前'}</span></p>
      {active && <button className="stop-recording" disabled={!!panel.pending} onClick={stop}>中断して記録停止</button>}
    </div>
    {[...new Set([presence.error, error, storage.error, status?.storage.error].filter(Boolean))].map((text) => <p className="error controller-alert" role="alert" key={text}>{text}</p>)}
    {unavailable && recording && <p className="notice controller-alert">通信が切れています。記録は保持しています。iPhoneを更新せず、同じ接続コードで接続し直してください。</p>}
    {recovery && <p className="notice controller-alert">iPhone更新による中断記録です。保存済みデータを回収してください。途中課題は自動再開しません。</p>}
    <ExperimentProgress index={progress.index} />
    <div className="controller-workspace">
      <section className="experiment-current" aria-label="現在の操作">
        <h2>{waitingForPhone ? '保存記録を復旧・iPhoneの接続を確認中' : progress.title}</h2>
        {panel.pending && <p role="status">操作を送信しています。iPhoneの応答を待っています。</p>}
        {!recording ? <>
          {unavailable && <><p>iPhoneで同じ接続コードのURLを開き、センサーの利用を許可してください。</p>
            {presence.sensorUrls.map((url) => <p key={url}><a href={url}>{url}</a></p>)}</>}
          {!unavailable && !status?.ready && <p>iPhone画面を表示し、「センサー利用を許可・準備」を押してください。</p>}
          {progressManager}
          <p>{!ready ? '接続・センサー受信・両端末の保存準備がそろうと開始できます。' : !selectedParticipant ? '参加者IDを選んでください。' : '説明・同意を確認したら記録を開始し、共通練習へ進みます。'}</p>
          <button className="primary" disabled={!selectedParticipant || !ready || !!panel.pending || reading} onClick={start}>記録を開始して練習へ</button>
        </> : waitingForPhone ? <p role="status">同じ接続コードのiPhoneを待っています。現在の記録は保持しています。必要なデータは「詳細・トラブル対応」から出力できます。</p> : <>
          {busy && <p className="notice" role="status">時刻合わせ中です。完了するまでお待ちください。</p>}
          {active && !busy && !collector.current?.research.hasStartCalibration && <><p className="error">開始時の時刻合わせが成立していません。</p>
            <button disabled={unavailable || !!panel.pending} onClick={calibrate}>時刻合わせを再計測</button></>}
          {progress.index === 1 && <><p className="status">{run?.purpose === 'practice' && !['complete', 'aborted'].includes(run.phase) ? 'iPhoneで練習中です。' : 'iPhoneの「練習問題を表示」から1問練習してください。'}</p>
            <p>選択・選び直し・情報が消えた後の回答まで体験します。練習が終わると、ここに最初の本番課題が表示されます。</p></>}
          {showTask && requiresRetry && <><p className="notice">この課題には既に試行記録があります。中断理由と再実施の対応を確認してください。</p><button onClick={showTroubleshooting}>再実施・中断の対応を開く</button></>}
          {showTask && !requiresRetry && <TaskController planned={planned} startAllowed={step?.kind === 'task'}
            run={run} count={collector.current?.taskCount ?? 0}
            elapsedSeconds={run?.startedAtMs != null ? ((status?.metadata?.startedAtMs ?? 0) + (status?.elapsedMs ?? 0) - run.startedAtMs) / 1000 : 0}
            disabled={taskDisabled} pending={!!panel.pending} onStart={startTask} onBegin={beginTask} onConfirmStopped={confirmStopped} />}
          {showSurvey && <QuestionnaireController focused allowedTarget={step.target} runs={surveys} tasks={collector.current?.assessableTaskRuns ?? []}
            disabled={unavailable || reading || !!panel.pending || busy || (run != null && !['complete', 'aborted'].includes(run.phase))} onOpen={openSurvey} />}
          {progress.index === 5 && <>
            {active ? <><p>両条件とアンケートが終了しました。センサー記録を停止してから、保存へ進みます。</p>
              <button className="primary" disabled={!!panel.pending || busy} onClick={stop}>記録を停止して保存へ</button></>
              : <>
                {!recovery && !busy && endClock && endClock.exchanges.length === 0 && <><p className="error">終了時の時刻合わせが成立していません。接続を確認してください。</p><button disabled={unavailable || !!panel.pending} onClick={calibrate}>終了時の時刻合わせを再計測</button></>}
                <p>受信件数：iPhone {status?.count ?? 0} ／ PC {panel.received} 件</p>
                {!panel.complete && <p className="notice">未受信または途中のデータがあります。回収状況を確認してください。途中データも出力できます。</p>}
                {step?.kind !== 'done' && <p className="notice">全課題・アンケートが終了した記録ではありません。中断した内容を確認して保存してください。</p>}
                <ol className="save-checklist"><li>JSON出力：{exports.json ? '操作済み' : '未'}</li><li>アンケートCSV出力：{surveys.length ? exports.csv ? '操作済み' : '未' : '回答記録なし'}</li><li>JSON読戻し一致：{verified.current ? '確認済み' : '未確認'}</li></ol>
                <div className="controls">
                  <button className={!exports.json ? 'primary' : undefined} disabled={reading || busy} onClick={download}>{exports.json ? 'JSONを再出力' : '1. JSONをPCに出力'}</button>
                  {surveys.length > 0 && <button className={exports.json && !exports.csv ? 'primary' : undefined} disabled={!exports.json || reading || busy} onClick={downloadQuestionnaires}>2. アンケートCSVをPCに出力</button>}
                </div>
                {exports.json && <SavedRecording key={collector.current?.metadata.sessionId} collector={collector} active={active}
                  reading={reading || busy} setReading={setReading} onVerified={() => { verified.current = true; refresh() }} />}
                {verified.current && <p className="success">JSONの一致を確認しました。出力したファイルを別の保存先にもバックアップしてください。</p>}
                <button className="primary" disabled={!canClear || !exports.json || !verified.current || (surveys.length > 0 && !exports.csv)} onClick={clear}>記録を保管して次の参加者へ</button>
              </>}
          </>}
        </>}
        {message && <p className="success" role="status">{message}</p>}
      </section>
      {active && recording && <div className="experiment-observation">
        <ObservationPanel compact log={collector.current?.research.snapshot() ?? null} active={observationActive}
          busy={busy} disabled={unavailable || (run != null && !['briefing', 'complete', 'aborted'].includes(run.phase))}
          hidden={hideInference} onHidden={setHideInference} onRecord={recordManualResearch} onCalibrate={calibrate} />
      </div>}
    </div>
    <details ref={details} className="controller-details"><summary>詳細・トラブル対応</summary>
      {recording && progressManager}
      <section>
      <h2>接続・準備確認</h2>
      <p role="status">サーバー：{connected ? '接続済み' : '切断／開発サーバー未接続'} ／ iPhone：{presence.sensor && connected ? '接続済み' : '未接続'}</p>
      <p>iPhone画面：{status ? status.visible ? '表示中' : '非表示' : '未確認'} ／ センサー取得：{status ? status.streaming ? '取得中' : '停止中' : '未確認'}</p>
      <p>センサー許可：{status?.permission ?? '未確認'} ／ 加速度3軸の受信確認：{status?.ready ? '準備済み' : '未完了'}</p>
      <p>iPhoneの受信イベント：{status?.receivedEventCount ?? 0}件 ／ 加速度3軸あり：{status?.validEventCount ?? 0}件</p>
      {presence.sensorUrls.map((url) => <p key={url}><a href={url}>iPhoneで開くURL：{url}</a></p>)}
      {!presence.sensorUrls.length && <p>LAN公開で起動し、iPhoneでNetworkのHTTPS URLに「?role=sensor&amp;room={identity.room}」を付けて開いてください。</p>}
      {unavailable && collector.current && <p className="notice">通信が途切れています。既にPCで受信したデータは保持しています。iPhoneのページを閉じず、同じ接続コードで再接続してください。</p>}
    </section>
      <StoragePanel state={storage} phone={status?.storage ?? null} journal={storage.journal} />
      <section><h2>記録の詳細</h2>
        <dl>
        <dt>記録件数：iPhone／PC／未受信</dt><dd>{status?.count ?? 0}／{panel.received}／{Math.max(0, (status?.count ?? 0) - panel.received)} 件</dd>
        <dt>PC記録内で加速度3軸がそろう件数（重力込みを含む）</dt><dd>{panel.valid} 件</dd>
        <dt>iPhone側の記録時間／最終イベントから</dt><dd>{seconds(status?.elapsedMs ?? 0)} 秒／{status?.sinceLastSampleMs == null ? '未受信' : `${seconds(status.sinceLastSampleMs)} 秒（iPhone報告時点）`}</dd>
        <dt>イベント受信時刻差（ms）</dt><dd>{number(latest?.receivedIntervalMs)}</dd>
        <dt>停止理由</dt><dd>{status?.completion?.stopReason ?? '—'}</dd>
      </dl>
      {!hideInference && <table><caption>iPhoneから届いた最新のセンサー値</caption><thead><tr><th>種類</th><th>x / α</th><th>y / β</th><th>z / γ</th></tr></thead><tbody>
        <tr><th>加速度<br /><small>m/s²</small></th><td>{number(latest?.acceleration?.x)}</td><td>{number(latest?.acceleration?.y)}</td><td>{number(latest?.acceleration?.z)}</td></tr>
        <tr><th>重力込み<br /><small>m/s²</small></th><td>{number(latest?.accelerationIncludingGravity?.x)}</td><td>{number(latest?.accelerationIncludingGravity?.y)}</td><td>{number(latest?.accelerationIncludingGravity?.z)}</td></tr>
        <tr><th>回転速度<br /><small>°/s</small></th><td>{number(latest?.rotationRate?.alpha)}</td><td>{number(latest?.rotationRate?.beta)}</td><td>{number(latest?.rotationRate?.gamma)}</td></tr>
      </tbody></table>}
      <p><small>「—」は欠損・未受信。生データは全件記録し、画面・通信はまとめて更新します。上限{MAX_SAMPLES}件で自動停止します。</small></p>
      <p><small>iPhoneの取得時刻とPCの受信時刻を別々に保存します。元の時刻と時刻合わせの通信記録を保持します。補正値は別途記録し、生データの時刻は書き換えません。</small></p>
        <div className="controls">
          <button disabled={!recording || reading || busy} onClick={download}>途中データを含めJSONを出力</button>
          {surveys.length > 0 && <button disabled={reading} onClick={downloadQuestionnaires}>アンケートCSVを出力</button>}
          <button disabled={!canClear} onClick={clear}>保存を確認して現在の記録を終了</button>
        </div>
      </section>
      {run && !hideInference && <section><h2>課題ログの詳細</h2><pre>{JSON.stringify(run, null, 2)}</pre></section>}
      <QuestionnaireController readOnly runs={surveys} tasks={collector.current?.assessableTaskRuns ?? []} disabled onOpen={openSurvey} />
      {!hideInference && <>
    <FeaturePreview collector={collector.current} />
    <section>
      <h2>自動状態推定（暫定設定）</h2>
      <p>Classifier（今回の判定）：{estimate ? stateLabels[estimate.classifiedState] : '判定前'} ／ Stabilizer（安定化後）：{estimate ? stateLabels[estimate.stabilizedState] : '判定前'}</p>
      <p>判定理由：{status?.latestEstimate?.classificationReason ?? '—'} ／ 安定化：{status?.latestEstimate?.stabilizationReason ?? '—'}</p>
      <p>推定ログ：iPhone {status?.estimateCount ?? 0}件 ／ PC {panel.estimates}件 ／ 未受信 {Math.max(0, (status?.estimateCount ?? 0) - panel.estimates)}件</p>
      <p>判定時刻（iPhone基準）：{number(status?.latestEstimate?.evaluatedAtMs)} ms ／ RMS：{number(status?.latestEstimate?.features.acceleration?.rootMeanSquare)} m/s²</p>
      {estimate?.stationaryFeatures && <p>静止確認用（{status?.estimationConfig?.stationaryWindowMs}ms）のRMS：{number(estimate.stationaryFeatures.acceleration?.rootMeanSquare)} m/s²</p>}
      <p><small>記録中のみiPhoneで推定します。停止後は最後の結果を表示します。これは実測調整用で、本番の性能は未評価です。課題の自動適応条件では、この安定化後の状態を表示へ反映します。</small></p>
      {status?.estimationConfig && <details><summary>今回の推定設定</summary><pre>{JSON.stringify(status.estimationConfig, null, 2)}</pre></details>}
    </section>
    </>}
    </details>
  </>
}
