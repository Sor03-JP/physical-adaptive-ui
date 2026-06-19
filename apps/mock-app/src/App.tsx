import { useState, useEffect, useRef, useCallback } from 'react';

type ActivityMode = 'static' | 'walking' | 'running';

interface ModeChangeEvent { mode: ActivityMode; isRunning?: boolean; resetCounters?: boolean }
interface TapEvent { type: 'success' | 'miss' }

export default function App() {
  const [mode, setMode] = useState<ActivityMode>('static');
  const [count, setCount] = useState<number>(0);
  const [missCount, setMissCount] = useState<number>(0);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  const [timeLimit, setTimeLimit] = useState<number>(20);
  const [timeLeft, setTimeLeft] = useState<number>(20);
  const [isExperimentRunning, setIsExperimentRunning] = useState<boolean>(false);
  const isExperimentRunningRef = useRef<boolean>(false);
  const modeRef = useRef<ActivityMode>('static');

  const updateExperimentRunning = useCallback((isRunning: boolean) => {
    isExperimentRunningRef.current = isRunning;
    setIsExperimentRunning(isRunning);
  }, []);

  const broadcastExperimentState = useCallback((isRunning: boolean, resetCounters = false) => {
    if (import.meta.hot) {
      import.meta.hot.send('custom:mode-change', {
        mode: modeRef.current,
        isRunning,
        resetCounters,
      });
    }
  }, []);

  useEffect(() => {
    const checkDevice = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkDevice();
    window.addEventListener('resize', checkDevice);
    return () => window.removeEventListener('resize', checkDevice);
  }, []);

  useEffect(() => {
    if (import.meta.hot) {
      const handleIncomingMode = (data: unknown) => {
        const event = data as ModeChangeEvent | null;
        const incomingMode = event?.mode;
        if (incomingMode === 'static' || incomingMode === 'walking' || incomingMode === 'running') {
          modeRef.current = incomingMode;
          setMode(incomingMode);
        }
        if (typeof event?.isRunning === 'boolean') {
          updateExperimentRunning(event.isRunning);
        }
        if (event?.resetCounters) {
          setCount(0);
          setMissCount(0);
        }
      };

      const handleIncomingTap = (data: unknown) => {
        if (!isExperimentRunningRef.current) return;

        const event = data as TapEvent | null;
        if (event?.type === 'success') {
          setCount((c) => c + 1);
        } else if (event?.type === 'miss') {
          setMissCount((m) => m + 1);
        }
      };

      import.meta.hot.on('custom:mode-change', handleIncomingMode);
      import.meta.hot.on('custom:tap-record', handleIncomingTap);

      return () => {
        import.meta.hot?.off('custom:mode-change', handleIncomingMode);
        import.meta.hot?.off('custom:tap-record', handleIncomingTap);
      };
    }
  }, [updateExperimentRunning]);

  useEffect(() => {
    let timer: number;

    if (isExperimentRunning && !isMobile) {
      timer = window.setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            updateExperimentRunning(false);
            broadcastExperimentState(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [broadcastExperimentState, isExperimentRunning, isMobile, updateExperimentRunning]);

  const handleModeChange = (newMode: ActivityMode) => {
    modeRef.current = newMode;
    setMode(newMode);
    if (import.meta.hot) {
      import.meta.hot.send('custom:mode-change', { mode: newMode });
    }
  };

  const handleStartExperiment = () => {
    setCount(0);
    setMissCount(0);
    setTimeLeft(timeLimit);
    updateExperimentRunning(true);
    broadcastExperimentState(true, true);
  };

  const handleResetCounters = () => {
    updateExperimentRunning(false);
    broadcastExperimentState(false, true);
    setCount(0);
    setMissCount(0);
    setTimeLeft(timeLimit);
  };

  const totalTaps = count + missCount;
  const errorRate = totalTaps > 0 ? ((missCount / totalTaps) * 100).toFixed(1) : '0.0';
  const avgTimePerTap = count > 0 ? ((timeLimit - timeLeft) / count).toFixed(2) : '0.00';

  if (!isMobile) {
    return (
      <div className="min-h-screen bg-slate-100 p-8 flex flex-col items-center justify-center font-sans text-slate-900">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-xl w-full text-center space-y-6">

          <div className="text-left">
            <h1 className="text-xl font-black tracking-tight">コントロールパネル</h1>
            <p className="text-sm text-slate-500 mt-1">タイマー管理、計測</p>
          </div>

          <div className="p-6 bg-slate-900 text-white rounded-xl flex items-center justify-between">
            <div className="text-left">
              <span className="text-xs font-mono uppercase tracking-wider text-slate-400 block">計測タイマー</span>
              <span className="text-4xl font-black font-mono">
                {timeLeft} <span className="text-sm font-normal text-slate-400">秒 / {timeLimit}秒</span>
              </span>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={isExperimentRunning}
                onClick={handleStartExperiment}
                className={`px-5 py-3 rounded-xl font-bold text-sm shadow transition-all ${
                  isExperimentRunning ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-600 text-white'
                }`}
              >
                {timeLeft === 0 ? '再テスト開始' : '計測スタート'}
              </button>
              <button
                type="button"
                onClick={handleResetCounters}
                className="px-4 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-xl text-sm font-bold transition-all"
              >
                リセット
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200">
              <span className="text-xs font-mono uppercase tracking-wider text-emerald-600 block mb-1">タップ成功回数</span>
              <span className="text-4xl font-black text-emerald-700">{count}</span>
            </div>
            <div className="p-4 bg-rose-50 rounded-xl border border-rose-200">
              <span className="text-xs font-mono uppercase tracking-wider text-rose-600 block mb-1">タップミス回数</span>
              <span className="text-4xl font-black text-rose-700">{missCount}</span>
            </div>
            <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
              <span className="text-xs font-mono uppercase tracking-wider text-amber-600 block mb-1">エラー率</span>
              <span className="text-3xl font-black text-amber-700">{errorRate}%</span>
            </div>
            <div className="p-4 bg-sky-50 rounded-xl border border-sky-200">
              <span className="text-xs font-mono uppercase tracking-wider text-sky-600 block mb-1">1タップ平均時間</span>
              <span className="text-3xl font-black text-sky-700">{avgTimePerTap}s</span>
            </div>
          </div>

          <div className="p-5 bg-slate-50 rounded-xl border border-slate-200 text-left space-y-3">
            <div>
              <span className="text-xs font-mono uppercase tracking-wider text-slate-400 block">1. テストする適応UIモードを事前に設定</span>
              <p className="text-xs text-slate-500">計測スタートを押す前に、ここで対象のデザインを選択しておきます</p>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              <button
                type="button"
                aria-pressed={mode === 'static'}
                onClick={() => handleModeChange('static')}
                className={`py-2.5 rounded-lg font-bold text-xs transition-all shadow-sm border ${
                  mode === 'static' ? 'bg-slate-950 text-white border-slate-950 ring-2 ring-slate-950/10' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                静止UI (通常)
              </button>
              <button
                type="button"
                aria-pressed={mode === 'walking'}
                onClick={() => handleModeChange('walking')}
                className={`py-2.5 rounded-lg font-bold text-xs transition-all shadow-sm border ${
                  mode === 'walking' ? 'bg-sky-500 text-white border-sky-500 ring-2 ring-sky-500/10' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                歩行UI (拡大)
              </button>
              <button
                type="button"
                aria-pressed={mode === 'running'}
                onClick={() => handleModeChange('running')}
                className={`py-2.5 rounded-lg font-bold text-xs transition-all shadow-sm border ${
                  mode === 'running' ? 'bg-amber-500 text-white border-amber-500 ring-2 ring-amber-500/10' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                走行UI (最大拡大)
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs font-mono text-slate-400 border-t pt-4">
            <div className="flex items-center gap-2">
              <span>試験時間設定:</span>
              <select
                disabled={isExperimentRunning}
                value={timeLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setTimeLimit(val);
                  setTimeLeft(val);
                }}
                className="bg-slate-200 text-slate-700 px-2 py-1 rounded"
              >
                <option value={10}>10秒</option>
                <option value={20}>20秒</option>
                <option value={30}>30秒</option>
              </select>
            </div>
            <span>Vite WebSocket System Ready</span>
          </div>

        </div>
      </div>
    );
  }

  const handleMobileTap = (type: 'success' | 'miss', e: React.MouseEvent) => {
    if (type === 'success') {
      e.stopPropagation();
    }

    if (!isExperimentRunningRef.current) return;

    if (type === 'success') setCount((c) => c + 1);
    if (type === 'miss') setMissCount((m) => m + 1);

    if (import.meta.hot) {
      import.meta.hot.send('custom:tap-record', { type });
    }
  };

  return (
    <div
      onClick={(e) => handleMobileTap('miss', e)}
      className={`h-dvh max-h-dvh overflow-hidden overscroll-none p-6 flex flex-col items-center transition-colors duration-300 select-none ${
        mode === 'static' ? 'bg-slate-50 text-slate-950' :
        mode === 'walking' ? 'bg-slate-900 text-slate-50' : 'bg-black text-white'
      }`}
    >
      <header className="w-full max-w-md text-center py-4 border-b border-slate-300/50 flex-none pointer-events-none">
        <h1 className="text-sm font-mono uppercase tracking-wider opacity-60">
          Adaptive UI Prototype (Sprint 2)
        </h1>
      </header>

      <main className="w-full max-w-md min-h-0 flex-1 flex flex-col pointer-events-none">
        <div className="min-h-0 flex-1 flex flex-col items-center justify-center text-center p-4">
          <div className="space-y-3">
            <p className="font-mono text-xs uppercase tracking-widest opacity-60">Current Design State</p>
            <h2 className={`font-black tracking-tight transition-all duration-300 ${
              mode === 'static' ? 'text-2xl' :
              mode === 'walking' ? 'text-4xl text-sky-400' : 'text-5xl text-amber-400 uppercase animate-pulse motion-reduce:animate-none'
            }`}>
              {mode === 'static' ? 'Normal UI' : mode === 'walking' ? 'Adaptive Large' : 'Running Bold'}
            </h2>
            <p className={`leading-relaxed max-w-sm mx-auto transition-all duration-300 ${
              mode === 'static' ? 'text-sm opacity-80' :
              mode === 'walking' ? 'text-lg opacity-90 font-medium' : 'text-xl font-bold tracking-wide'
            }`}>
              身体の移動や振動による視覚的負荷を和らげるため、コンテキストに応じて文字サイズとコントラストを動的に適応させています。
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 flex flex-col items-center justify-center p-4 relative">
          <button
            type="button"
            disabled={!isExperimentRunning}
            aria-label={isExperimentRunning ? 'タップを記録' : '計測時間外'}
            onClick={(e) => handleMobileTap('success', e)}
            className={`font-black rounded-2xl shadow-xl transition-all duration-300 text-center flex items-center justify-center pointer-events-auto ${
              isExperimentRunning ? 'active:scale-95' : 'cursor-not-allowed opacity-50'
            } ${
              mode === 'static'
                ? 'w-36 h-12 bg-slate-900 text-white text-sm hover:bg-slate-800'
                : mode === 'walking'
                ? 'w-56 h-24 bg-sky-500 text-white text-2xl tracking-wider ring-4 ring-sky-500/30'
                : 'w-72 h-36 bg-amber-400 text-white text-4xl tracking-widest border-4 border-white ring-8 ring-amber-400/20'
            }`}
          >
            {isExperimentRunning ? `TAP : ${count}` : '計測時間外'}
          </button>

          <span className={`absolute bottom-4 font-mono text-xs opacity-50 transition-all ${
            mode === 'running' ? 'text-sm font-bold opacity-100 text-amber-400' : ''
          }`}>
            Target Safeguard: {mode === 'static' ? 'OFF' : mode === 'walking' ? 'MID (+50%)' : 'MAX (+100%)'}
          </span>
        </div>
      </main>

      <footer className="w-full max-w-md text-center py-2 border-t border-slate-300/30 font-mono text-xs opacity-40 flex-none pointer-events-none">
        Context Status: {mode.toUpperCase()}
      </footer>
    </div>
  );
}
