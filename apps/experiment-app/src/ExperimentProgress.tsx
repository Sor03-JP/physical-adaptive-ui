export default function ExperimentProgress({ index }: { index: number }) {
  return <ol className="experiment-progress" aria-label="実験の進行">
    {['準備', '練習', '第1条件', '第2条件', '比較', '保存'].map((label, i) =>
      <li key={label} aria-current={index === i ? 'step' : undefined} data-complete={i < index || undefined}>
        <span>{i + 1}</span>{label}
      </li>)}
  </ol>
}
