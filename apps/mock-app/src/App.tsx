import { useState, useEffect } from 'react'; // 1. useEffect を追加

type ActivityMode = 'static' | 'walking' | 'running';

export default function App() {
  const [mode, setMode] = useState<ActivityMode>('static');
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.on('custom:mode-change', (data: { mode: ActivityMode }) => {
        setMode(data.mode);
      });
    }
  }, []);

  const handleModeChange = (newMode: ActivityMode) => {
    setMode(newMode);

    if (import.meta.hot) {
      import.meta.hot.send('custom:mode-change', { mode: newMode });
    }
  };

  return (
    <div className={`min-h-screen p-6 flex flex-col items-center justify-between font-sans transition-colors duration-300 ${
      mode === 'static' ? 'bg-slate-50 text-slate-950' :
      mode === 'walking' ? 'bg-slate-900 text-slate-50' : 'bg-black text-white'
    }`}>

      <header className="w-full max-w-md text-center py-4 border-b border-slate-300/50">
        <h1 className="text-sm font-mono uppercase tracking-wider opacity-60 mb-3">
          Adaptive UI Prototype (Sprint 2)
        </h1>

        <div className="inline-flex rounded-lg p-1 bg-slate-200/80 dark:bg-slate-800/80 backdrop-blur">
          <button
            onClick={() => handleModeChange('static')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${
              mode === 'static' ? 'bg-white text-slate-900 shadow' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            静止 (Static)
          </button>
          <button
            onClick={() => handleModeChange('walking')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${
              mode === 'walking' ? 'bg-sky-500 text-white shadow' : 'text-slate-500 hover:text-slate-400'
            }`}
          >
            歩行 (Walking)
          </button>
          <button
            onClick={() => handleModeChange('running')}
            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${
              mode === 'running' ? 'bg-amber-500 text-black shadow' : 'text-slate-500 hover:text-slate-400'
            }`}
          >
            走行 (Running)
          </button>
        </div>
      </header>

      <main className="w-full max-w-md my-auto flex flex-col items-center justify-center space-y-8">
        <div className="text-center space-y-2 px-4">
          <p className="font-mono text-xs uppercase tracking-widest opacity-60">
            Current Design State
          </p>
          <h2 className={`font-black tracking-tight transition-all duration-300 ${
            mode === 'static' ? 'text-2xl' :
            mode === 'walking' ? 'text-4xl text-sky-400' : 'text-6xl text-amber-400 uppercase animate-pulse'
          }`}>
            {mode === 'static' ? 'Normal UI' : mode === 'walking' ? 'Adaptive Large' : 'Running Bold'}
          </h2>
          <p className={`leading-relaxed max-w-sm mx-auto transition-all duration-300 ${
            mode === 'static' ? 'text-sm opacity-80' :
            mode === 'walking' ? 'text-lg opacity-90 font-medium' : 'text-2xl font-bold tracking-wide'
          }`}>
            身体の移動や振動による視覚的負荷を和らげるため、コンテキストに応じて文字サイズとコントラストを動的に適応させています。
          </p>
        </div>

        <div className="w-full px-4 flex flex-col items-center">
          <button
            onClick={() => setCount(count + 1)}
            className={`font-black rounded-2xl shadow-xl transition-all duration-300 active:scale-95 text-center ${
              mode === 'static'
                ? 'w-auto px-6 py-3 bg-slate-900 text-white text-sm hover:bg-slate-800'
                : mode === 'walking'
                ? 'w-full py-6 bg-sky-500 text-white text-xl tracking-wider ring-4 ring-sky-500/30'
                : 'w-full py-10 bg-amber-400 text-black text-3xl tracking-widest border-4 border-white ring-8 ring-amber-400/20'
            }`}
          >
            TAP HERE : {count}
          </button>

          <span className={`mt-3 font-mono text-xs opacity-50 transition-all ${
            mode === 'running' ? 'text-lg font-bold opacity-100 text-amber-400' : ''
          }`}>
            Target Accuracy Safeguard: {mode === 'static' ? 'OFF' : mode === 'walking' ? 'MID (Padding +50%)' : 'MAX (Padding +200%)'}
          </span>
        </div>

      </main>

      <footer className="w-full max-w-md text-center py-4 border-t border-slate-300/30 font-mono text-xs opacity-40">
        Context Status: {mode.toUpperCase()}
      </footer>

    </div>
  );
}
