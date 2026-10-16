import { assignments } from './management'
import type { Participant, NextStep } from './management'
import type { TaskRun } from './task-schema'

export function experimentProgress({ recording, active, recovery, participant, step, run }: {
  recording: boolean; active: boolean; recovery: boolean; participant: Participant | null
  step: NextStep | null; run: TaskRun | null
}) {
  if (!recording) return { index: 0, title: '接続・参加者を確認して記録開始' }
  if (recovery || !active) return { index: 5, title: recovery ? '中断した記録を回収・保存' : '記録を保存して確認' }
  if (step?.kind === 'done') return { index: 5, title: '全課題終了・記録を停止' }
  if (step?.kind === 'practice' || (step?.kind === 'active' && run?.purpose === 'practice')) return { index: 1, title: 'iPhoneで共通練習' }
  if (step?.kind === 'survey' && step.target === 'final') return { index: 4, title: '最後の比較・自由回答' }
  const mode = step?.kind === 'task' ? step.mode : step?.kind === 'survey' ? step.target : run?.mode
  const block = participant ? assignments[participant.group].findIndex((b) => b.mode === mode) : -1
  const number = block === 1 ? 2 : 1
  const taskId = step?.kind === 'task' ? step.taskId : run?.taskId
  return { index: block === 1 ? 3 : 2, title: step?.kind === 'survey'
    ? `第${number}条件・アンケート` : `第${number}条件・課題${taskId?.slice(1) ?? ''}／3` }
}

export default function ExperimentProgress({ index }: { index: number }) {
  return <ol className="experiment-progress" aria-label="実験の進行">
    {['準備', '練習', '第1条件', '第2条件', '比較', '保存'].map((label, i) =>
      <li key={label} aria-current={index === i ? 'step' : undefined} data-complete={i < index || undefined}>
        <span>{i + 1}</span>{label}
      </li>)}
  </ol>
}
