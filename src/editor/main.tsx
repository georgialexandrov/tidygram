import { createRoot } from 'react-dom/client';
// The package's exports map hides the .wasm, so it is referenced by path.
import wasmUrl from '../../node_modules/libavoid-js/dist/libavoid.wasm?url';
import { loadAvoid } from '../scene/avoid.ts';
import ElkApi from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { setElkFactory, type ElkLike } from '../layout/elk.ts';

// One ELK worker per core (max 16), handed out round-robin: layouts run in parallel, off the main thread.
const workers = Math.max(2, Math.min(16, navigator.hardwareConcurrency || 4));
const pool: ElkLike[] = Array.from({ length: workers }, () => new ElkApi({ workerFactory: () => new Worker(elkWorkerUrl) }));
let next = 0;
setElkFactory(() => pool[next++ % pool.length]!);
import { Editor } from './Editor.tsx';

async function start() {
  const avoid = await loadAvoid(wasmUrl);
  createRoot(document.getElementById('root')!).render(<Editor avoid={avoid} />);
}

void start();
