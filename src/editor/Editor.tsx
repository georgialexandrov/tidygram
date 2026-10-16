import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { perf } from './perf.ts';
import { SourcePanel } from './SourcePanel.tsx';
import { renderToStaticMarkup } from 'react-dom/server';
import { ensureLayout, type LayoutMode } from '../layout/auto.ts';
import { emptyLayout, parseLayout, serializeLayout, type LayoutFile, type Point } from '../layout/layout-file.ts';
import { parsePuml } from '../model/parse.ts';
import type { Diagram, ParseWarning } from '../model/types.ts';
import { DiagramContent, DiagramSvg, type Interaction } from '../render/DiagramSvg.tsx';
import type { Avoid } from '../scene/avoid.ts';
import { overlaps, type Box } from '../scene/containers.ts';
import { buildScene, type Scene } from '../scene/scene.ts';
import { FRAME_PRESETS, frameRect } from '../scene/frame.ts';
import { THEMES } from '../scene/theme.ts';
import { fitToFrame } from '../layout/fit.ts';
import { largestScale } from '../layout/scale.ts';

const SIZES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
import { alignmentSnap, clearVia, insertVia, moveNodes, moveVia, removeVia, setLabelOffset, setPinned, type Guide } from './edits.ts';

interface Doc {
  file: string;
  source: string;
  diagram: Diagram;
  warnings: ParseWarning[];
}

/** −/+ stepper; clicking the value resets to 100%. */
function Stepper({ label, value, onChange, title }: { label: string; value: number; onChange(v: number): void; title: string }) {
  const step = (d: number) => onChange(Math.min(3, Math.max(0.5, Math.round((value + d) * 10) / 10)));
  return (
    <span className="stepper" title={title}>
      <span className="stepper-label">{label}</span>
      <button onClick={() => step(-0.1)} aria-label={`Smaller ${label.toLowerCase()}`}>
        −
      </button>
      <button className="stepper-value" onClick={() => onChange(1)} title="Reset to 100%">
        {Math.round(value * 100)}%
      </button>
      <button onClick={() => step(0.1)} aria-label={`Larger ${label.toLowerCase()}`}>
        +
      </button>
    </span>
  );
}

interface View {
  x: number;
  y: number;
  k: number;
}

type Drag =
  | {
      kind: 'nodes';
      ids: string[];
      primary: string;
      start: Point;
      before: LayoutFile;
      origin: Record<string, { x: number; y: number }>;
      originVia: Record<string, Point[]>;
      moved: boolean;
    }
  | { kind: 'edge'; id: string; start: Point; before: LayoutFile }
  | { kind: 'via'; id: string; index: number; before: LayoutFile; base: LayoutFile; moved: boolean }
  | { kind: 'label'; id: string; start: Point; origin: Point; before: LayoutFile; moved: boolean }
  | { kind: 'pan'; client: Point; origin: View; moved: boolean }
  | { kind: 'marquee'; start: Point };

const DRAG_THRESHOLD = 3;
const SNAP = 6;

function descendants(diagram: Diagram, container: string): string[] {
  const ids = new Set([container]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of diagram.containers) if (c.parent && ids.has(c.parent) && !ids.has(c.id)) ids.add(c.id), (grew = true);
  }
  return diagram.nodes.filter((n) => n.parent && ids.has(n.parent)).map((n) => n.id);
}

export function Editor({ avoid }: { avoid: Avoid }) {
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<string | null>(() => new URLSearchParams(location.search).get('file'));
  const [doc, setDoc] = useState<Doc | null>(null);
  const [layout, setLayout] = useState<LayoutFile>(emptyLayout);
  const [error, setError] = useState<string | null>(null);
  const [selNodes, setSelNodes] = useState<ReadonlySet<string>>(new Set());
  const [selEdge, setSelEdge] = useState<string | undefined>();
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showWarnings, setShowWarnings] = useState(false);
  const [grid, setGrid] = useState(() => localStorage.getItem('puml-layout:grid') !== 'off');
  const [busy, setBusy] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(() => localStorage.getItem('puml-layout:source') === 'on');

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  /** While dragging: what moved, so only its lines are re-routed. Null means a full build. */
  const dirty = useRef<{ nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | null>(null);
  const previousScene = useRef<Scene | null>(null);
  const undoStack = useRef<LayoutFile[]>([]);
  const redoStack = useRef<LayoutFile[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const fileRef = useRef(file);
  fileRef.current = file;
  const viewRef = useRef(view);
  viewRef.current = view;
  const saveTimer = useRef<number | undefined>(undefined);
  const needsFit = useRef(true);

  const save = useCallback((next: LayoutFile) => {
    const target = fileRef.current;
    if (!target) return;
    setStatus('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/layout?file=${encodeURIComponent(target)}`, { method: 'PUT', body: serializeLayout(next) });
        setStatus(res.ok ? 'saved' : 'error');
      } catch {
        setStatus('error');
      }
    }, 250);
  }, []);

  /** Applies a finished edit: undoable, saved. */
  const commit = useCallback(
    (next: LayoutFile, before: LayoutFile = layoutRef.current) => {
      undoStack.current.push(before);
      if (undoStack.current.length > 200) undoStack.current.shift();
      redoStack.current = [];
      setLayout(next);
      save(next);
    },
    [save],
  );

  const load = useCallback(
    async (target: string, what: 'all' | 'source' | 'layout' = 'all') => {
      try {
        const res = await fetch(`/api/doc?file=${encodeURIComponent(target)}`);
        if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
        const body = (await res.json()) as { source: string; layout: string | null };
        const parsed = parsePuml(body.source);
        let base = layoutRef.current;
        if (what !== 'source') {
          try {
            base = parseLayout(body.layout ?? '');
          } catch {
            setError('layout.json is not valid JSON, ignoring it until it is fixed');
            return;
          }
        }
        const next = await ensureLayout(parsed.diagram, base, 'fill');
        if (what === 'all') {
          undoStack.current = [];
          redoStack.current = [];
          setSelNodes(new Set());
          setSelEdge(undefined);
          needsFit.current = true;
        } else {
          undoStack.current.push(layoutRef.current);
        }
        setDoc({ file: target, source: body.source, diagram: parsed.diagram, warnings: parsed.warnings });
        setLayout(next);
        setError(null);
        if (serializeLayout(next) !== (body.layout ?? '')) save(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [save],
  );

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((j: { files: string[] }) => {
        setFiles(j.files);
        if (!fileRef.current && j.files[0]) setFile(j.files[0]);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!file) return;
    const url = new URL(location.href);
    url.searchParams.set('file', file);
    history.replaceState(null, '', url);
    void load(file);
  }, [file, load]);

  // Live reload when the .puml (or the layout) changes on disk.
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const handler = (data: { file: string; what: 'source' | 'layout' }) => {
      if (data.file === fileRef.current) void load(data.file, data.what);
    };
    hot.on('puml:changed', handler);
    return () => hot.off('puml:changed', handler);
  }, [load]);

  const scene: Scene | null = useMemo(() => {
    if (!doc) return null;
    try {
      const t0 = performance.now();
      const fast = dirty.current && previousScene.current ? { previous: previousScene.current, dirty: dirty.current } : {};
      const built = buildScene(doc.diagram, layout, avoid, fast);
      perf.record(dirty.current ? 'scene (drag)' : 'scene (full)', performance.now() - t0);
      previousScene.current = built;
      return built;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [doc, layout, avoid]);

  // Time from the input event to the DOM being updated, and to the next painted frame.
  useLayoutEffect(() => {
    const start = perf.inputAt;
    if (start === undefined) return;
    perf.inputAt = undefined;
    perf.record('commit', performance.now() - start);
    requestAnimationFrame(() => requestAnimationFrame(() => perf.record('frame', performance.now() - start)));
  }, [scene]);

  const frame = layout.view?.frame;
  const frameBox = useMemo(() => (scene && frame ? frameRect(scene.bounds, frame) : null), [scene, frame]);

  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!scene || !svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const b = frameBox ?? scene.bounds;
    const k = Math.min(2, (width - 80) / Math.max(b.w, 1), (height - 80) / Math.max(b.h, 1));
    setView({ k, x: (width - b.w * k) / 2 - b.x * k, y: (height - b.h * k) / 2 - b.y * k });
  }, [scene, frameBox]);

  useEffect(() => {
    if (scene && needsFit.current) {
      needsFit.current = false;
      fit();
    }
  }, [scene, fit]);

  const toDiagram = useCallback((clientX: number, clientY: number): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(clientX - rect.left - v.x) / v.k, (clientY - rect.top - v.y) / v.k];
  }, []);

  const capture = (e: ReactPointerEvent) => svgRef.current?.setPointerCapture(e.pointerId);

  const startNodeDrag = (ids: string[], primary: string, e: ReactPointerEvent) => {
    const l = layoutRef.current;
    const origin = Object.fromEntries(ids.filter((id) => l.nodes[id]).map((id) => [id, { x: l.nodes[id]!.x, y: l.nodes[id]!.y }]));
    const originVia = Object.fromEntries(Object.entries(l.edges).flatMap(([id, e2]) => (e2.via ? [[id, e2.via]] : [])));
    drag.current = { kind: 'nodes', ids, primary, start: toDiagram(e.clientX, e.clientY), before: l, origin, originVia, moved: false };
    capture(e);
  };

  const ix: Interaction = {
    selectedNodes: selNodes,
    selectedEdge: selEdge,
    showPins: true,
    onNodeDown(id, e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      let selection = new Set(selNodes);
      if (e.shiftKey) {
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
      } else if (!selection.has(id)) {
        selection = new Set([id]);
      }
      setSelNodes(selection);
      setSelEdge(undefined);
      if (selection.has(id)) startNodeDrag([...selection], id, e);
    },
    onContainerDown(id, e) {
      if (e.button !== 0 || !doc) return;
      e.stopPropagation();
      const ids = descendants(doc.diagram, id);
      if (!ids.length) return;
      setSelNodes(new Set(ids));
      setSelEdge(undefined);
      startNodeDrag(ids, ids[0]!, e);
    },
    onEdgeDown(id, e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      setSelEdge(id);
      setSelNodes(new Set());
      drag.current = { kind: 'edge', id, start: toDiagram(e.clientX, e.clientY), before: layoutRef.current };
      capture(e);
    },
    onEdgeDoubleClick(id, e) {
      if (!doc) return;
      e.stopPropagation();
      const p = toDiagram(e.clientX, e.clientY);
      commit(insertVia(layoutRef.current, doc.diagram, id, [Math.round(p[0]), Math.round(p[1])]).layout);
    },
    onLabelDown(id, e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      setSelEdge(id);
      setSelNodes(new Set());
      const l = layoutRef.current;
      drag.current = { kind: 'label', id, start: toDiagram(e.clientX, e.clientY), origin: l.edges[id]?.label ?? [0, 0], before: l, moved: false };
      capture(e);
    },
    onViaDown(id, index, e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      const l = layoutRef.current;
      drag.current = { kind: 'via', id, index, before: l, base: l, moved: false };
      capture(e);
    },
    onViaDoubleClick(id, index, e) {
      e.stopPropagation();
      commit(removeVia(layoutRef.current, id, index));
    },
  };

  // Elements are memoized, so they get one stable object that forwards to this render's handlers.
  const ixRef = useRef(ix);
  ixRef.current = ix;
  const stableIx = useMemo<Interaction>(
    () => ({
      get selectedNodes() {
        return ixRef.current.selectedNodes;
      },
      get selectedEdge() {
        return ixRef.current.selectedEdge;
      },
      showPins: true,
      onNodeDown: (id, e) => ixRef.current.onNodeDown(id, e),
      onContainerDown: (id, e) => ixRef.current.onContainerDown(id, e),
      onEdgeDown: (id, e) => ixRef.current.onEdgeDown(id, e),
      onEdgeDoubleClick: (id, e) => ixRef.current.onEdgeDoubleClick(id, e),
      onLabelDown: (id, e) => ixRef.current.onLabelDown(id, e),
      onViaDown: (id, i, e) => ixRef.current.onViaDown(id, i, e),
      onViaDoubleClick: (id, i, e) => ixRef.current.onViaDoubleClick(id, i, e),
    }),
    [],
  );

  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.shiftKey && e.button === 0) {
      drag.current = { kind: 'marquee', start: toDiagram(e.clientX, e.clientY) };
    } else {
      drag.current = { kind: 'pan', client: [e.clientX, e.clientY], origin: viewRef.current, moved: false };
    }
    capture(e);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || !doc) return;
    perf.inputAt ??= performance.now();
    const p = toDiagram(e.clientX, e.clientY);
    const k = viewRef.current.k;
    switch (d.kind) {
      case 'nodes': {
        let dx = p[0] - d.start[0];
        let dy = p[1] - d.start[1];
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD / k) return;
        d.moved = true;
        const primary = d.origin[d.primary];
        if (primary && !e.altKey) {
          const moving = new Set(d.ids);
          const others = Object.entries(d.before.nodes)
            .filter(([id]) => !moving.has(id) && doc.diagram.nodes.some((n) => n.id === id))
            .map(([, n]) => n);
          const snap = alignmentSnap({ x: primary.x + dx, y: primary.y + dy }, others, SNAP / k);
          dx += snap.dx;
          dy += snap.dy;
          setGuides(snap.guides);
        } else {
          setGuides([]);
        }
        dirty.current = { nodes: new Set(d.ids), edges: new Set() };
        setLayout(moveNodes(d.before, doc.diagram, d.origin, d.originVia, Math.round(dx), Math.round(dy)));
        break;
      }
      case 'edge': {
        if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < DRAG_THRESHOLD / k) return;
        // Grabbing a line and pulling it adds a bend under the pointer.
        const { layout: base, index } = insertVia(d.before, doc.diagram, d.id, [Math.round(p[0]), Math.round(p[1])]);
        if (index < 0) return;
        drag.current = { kind: 'via', id: d.id, index, before: d.before, base, moved: true };
        dirty.current = { nodes: new Set(), edges: new Set([d.id]) };
        setLayout(base);
        break;
      }
      case 'via':
        d.moved = true;
        dirty.current = { nodes: new Set(), edges: new Set([d.id]) };
        setLayout(moveVia(d.base, d.id, d.index, [Math.round(p[0]), Math.round(p[1])]));
        break;
      case 'label': {
        const dx = p[0] - d.start[0];
        const dy = p[1] - d.start[1];
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD / k) return;
        d.moved = true;
        dirty.current = { nodes: new Set(), edges: new Set([d.id]) };
        setLayout(setLabelOffset(d.before, d.id, [Math.round(d.origin[0] + dx), Math.round(d.origin[1] + dy)]));
        break;
      }
      case 'pan': {
        const dx = e.clientX - d.client[0];
        const dy = e.clientY - d.client[1];
        if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        setView({ ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy });
        break;
      }
      case 'marquee':
        setMarquee({
          x: Math.min(d.start[0], p[0]),
          y: Math.min(d.start[1], p[1]),
          w: Math.abs(p[0] - d.start[0]),
          h: Math.abs(p[1] - d.start[1]),
        });
        break;
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // The drag is over: the next build routes and nudges every line again (a new layout object forces it).
    dirty.current = null;
    setGuides([]);
    if (!d) return;
    switch (d.kind) {
      case 'nodes':
        if (d.moved) commit(setPinned(layoutRef.current, d.ids, true), d.before);
        break;
      case 'via':
      case 'label':
        if (d.moved) commit({ ...layoutRef.current }, d.before);
        break;
      case 'pan':
        if (!d.moved) {
          setSelNodes(new Set());
          setSelEdge(undefined);
        }
        break;
      case 'marquee':
        if (marquee && scene) {
          setSelNodes(new Set(scene.nodes.filter((n) => overlaps(n.box, marquee)).map((n) => n.node.id)));
          setSelEdge(undefined);
        }
        setMarquee(null);
        break;
      case 'edge':
        break;
    }
  };

  // Wheel: pinch / ctrl+wheel zooms at the cursor, plain wheel pans. Needs a non-passive listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = Math.min(4, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.01)));
        setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(layoutRef.current);
    setLayout(prev);
    save(prev);
  }, [save]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(layoutRef.current);
    setLayout(next);
    save(next);
  }, [save]);

  const runLayout = useCallback(
    async (mode: LayoutMode) => {
      if (!doc) return;
      if (mode === 'reset' && !confirm('Discard all positions, pins and bends, and lay out from scratch?')) return;
      commit(await ensureLayout(doc.diagram, layoutRef.current, mode));
    },
    [doc, commit],
  );

  const updateViewSettings = useCallback(
    (patch: { theme?: string; frame?: Point | null; scale?: number; text?: number; icons?: number }) => {
      const l = layoutRef.current;
      const view = { ...l.view };
      for (const key of ['text', 'icons'] as const) {
        const v = patch[key];
        if (v === undefined) continue;
        if (v === 1) delete view[key];
        else view[key] = v;
      }
      if (patch.theme !== undefined) view.theme = patch.theme;
      if (patch.scale !== undefined) {
        if (patch.scale === 1) delete view.scale;
        else view.scale = patch.scale;
      }
      if (patch.frame === null) delete view.frame;
      else if (patch.frame) view.frame = patch.frame;
      commit({ ...l, view });
      if (patch.theme !== undefined || patch.frame !== undefined || patch.scale !== undefined) needsFit.current = true;
    },
    [commit],
  );

  const fitFrame = useCallback(async () => {
    if (!doc || !frame) return;
    setBusy('Fitting…');
    // Let the "Fitting…" state paint before ELK occupies the main thread.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const t0 = performance.now();
      const result = await fitToFrame(doc.diagram, layoutRef.current, frame, avoid);
      perf.record('fit', performance.now() - t0);
      for (const [phase, ms] of Object.entries(result.timings)) perf.record(`fit: ${phase}`, ms);
      commit(result.layout);
      needsFit.current = true;
      setBusy(`Fitted in ${(performance.now() - t0) / 1000 < 1 ? `${Math.round(performance.now() - t0)} ms` : `${((performance.now() - t0) / 1000).toFixed(1)} s`}: ${result.variant} · text ${Math.round(result.scale * 100)}%`);
      window.setTimeout(() => setBusy(null), 4000);
    } catch (e) {
      setBusy(null);
      setError(String(e));
    }
  }, [doc, frame, avoid, commit]);

  const toggleSource = useCallback((on?: boolean) => {
    setShowSource((prev) => {
      const next = on ?? !prev;
      localStorage.setItem('puml-layout:source', next ? 'on' : 'off');
      return next;
    });
  }, []);

  // The panel takes canvas width; refit so nothing ends up hidden behind it.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    const id = requestAnimationFrame(() => fitRef.current());
    return () => cancelAnimationFrame(id);
  }, [showSource]);

  /** Source lines of the selection: element declarations and the relations of a selected line. */
  const highlightedLines = useMemo(() => {
    const lines = new Set<number>();
    if (!doc) return lines;
    for (const n of doc.diagram.nodes) if (selNodes.has(n.id)) lines.add(n.line);
    const edge = doc.diagram.edges.find((e) => e.id === selEdge);
    if (edge) lines.add(edge.line);
    return lines;
  }, [doc, selNodes, selEdge]);

  const selectLine = useCallback(
    (line: number) => {
      if (!doc) return;
      const nodes = doc.diagram.nodes.filter((n) => n.line === line).map((n) => n.id);
      const edge = doc.diagram.edges.find((e) => e.line === line);
      if (nodes.length) {
        setSelNodes(new Set(nodes));
        setSelEdge(undefined);
      } else if (edge) {
        setSelEdge(edge.id);
        setSelNodes(new Set());
      }
    },
    [doc],
  );

  const exportSvg = useCallback(() => {
    if (!scene || !doc) return;
    const markup = renderToStaticMarkup(<DiagramSvg scene={scene} frame={frame} />);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    a.download = doc.file.split('/').pop()!.replace(/\.\w+$/, '') + '.svg';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [scene, doc, frame]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a' && doc) {
        e.preventDefault();
        setSelNodes(new Set(doc.diagram.nodes.map((n) => n.id)));
        return;
      }
      if (e.key === 'Escape') {
        setSelNodes(new Set());
        setSelEdge(undefined);
        return;
      }
      if (e.key === 'f' && !mod) return fit();
      if (e.key === 's' && !mod) return toggleSource();
      if (e.key === 'u' && !mod && selNodes.size) return commit(setPinned(layoutRef.current, selNodes, false));
      if ((e.key === 'Backspace' || e.key === 'Delete') && selEdge) return commit(clearVia(layoutRef.current, selEdge));
      const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const arrow = arrows[e.key];
      if (arrow && selNodes.size && doc) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const l = layoutRef.current;
        const origin = Object.fromEntries([...selNodes].filter((id) => l.nodes[id]).map((id) => [id, l.nodes[id]!]));
        const originVia = Object.fromEntries(Object.entries(l.edges).flatMap(([id, x]) => (x.via ? [[id, x.via]] : [])));
        commit(setPinned(moveNodes(l, doc.diagram, origin, originVia, arrow[0] * step, arrow[1] * step), selNodes, true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, selNodes, selEdge, commit, undo, redo, fit, toggleSource]);

  const pinnedCount = doc ? doc.diagram.nodes.filter((n) => layout.nodes[n.id]?.pinned).length : 0;
  const staleCount = doc ? Object.keys(layout.nodes).filter((id) => !doc.diagram.nodes.some((n) => n.id === id)).length : 0;
  const big = 1e5;

  return (
    <div className="app">
      <header className="toolbar">
        <select value={file ?? ''} onChange={(e) => setFile(e.target.value)}>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button onClick={fit} title="Fit to window (F)">
          Fit
        </button>
        <span className="sep" />
        <button onClick={() => void runLayout('auto')} title="Re-layout everything you haven't placed by hand">
          Auto layout
        </button>
        <button onClick={() => void runLayout('reset')} title="Discard the layout and start over">
          Reset
        </button>
        <button disabled={!selNodes.size} onClick={() => commit(setPinned(layoutRef.current, selNodes, false))} title="Unpin selected (U)">
          Unpin
        </button>
        <button disabled={!selEdge} onClick={() => selEdge && commit(clearVia(layoutRef.current, selEdge))} title="Remove bends from the selected line (Delete)">
          Straighten
        </button>
        <span className="sep" />
        <button onClick={undo} title="Undo (⌘Z)">
          Undo
        </button>
        <button onClick={redo} title="Redo (⇧⌘Z)">
          Redo
        </button>
        <span className="sep" />
        <select value={layout.view?.theme ?? 'classic'} onChange={(e) => updateViewSettings({ theme: e.target.value })} title="Theme">
          {Object.values(THEMES).map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          value={String(layout.view?.scale ?? 1)}
          onChange={(e) => {
            if (e.target.value === 'max') {
              if (doc) updateViewSettings({ scale: largestScale(doc.diagram, { ...layoutRef.current, view: { ...layoutRef.current.view, scale: 1 } }) });
              return;
            }
            updateViewSettings({ scale: Number(e.target.value) });
          }}
          title="Size of text, icons and shapes"
        >
          {[...new Set([...SIZES, layout.view?.scale ?? 1])].sort((a, b) => a - b).map((v) => (
            <option key={v} value={String(v)}>
              Size {Math.round(v * 100)}%
            </option>
          ))}
          <option value="max">Largest that fits</option>
        </select>
        <Stepper label="Text" value={layout.view?.text ?? 1} onChange={(v) => updateViewSettings({ text: v })} title="Text size, on top of Size" />
        <Stepper label="Icons" value={layout.view?.icons ?? 1} onChange={(v) => updateViewSettings({ icons: v })} title="Actor and system icon size, on top of Size" />
        <select
          value={frame ? `${frame[0]}:${frame[1]}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return updateViewSettings({ frame: null });
            if (v === 'window') {
              const r = svgRef.current!.getBoundingClientRect();
              return updateViewSettings({ frame: [Math.round(r.width), Math.round(r.height)] });
            }
            const [w, h] = v.split(':').map(Number);
            updateViewSettings({ frame: [w!, h!] });
          }}
          title="Frame: the shape the diagram should fit"
        >
          <option value="">No frame</option>
          {FRAME_PRESETS.map((p) => (
            <option key={p.label} value={`${p.frame[0]}:${p.frame[1]}`}>
              {p.label}
            </option>
          ))}
          {frame && !FRAME_PRESETS.some((p) => p.frame[0] === frame[0] && p.frame[1] === frame[1]) && (
            <option value={`${frame[0]}:${frame[1]}`}>
              {frame[0]}:{frame[1]}
            </option>
          )}
          <option value="window">This window</option>
        </select>
        <button disabled={!frame || !!busy?.endsWith('…')} onClick={() => void fitFrame()} title="Re-arrange everything to fill the frame (undoable)">
          Fit to frame
        </button>
        <label className="toggle" title="Dotted grid behind the diagram">
          <input
            type="checkbox"
            checked={grid}
            onChange={(e) => {
              setGrid(e.target.checked);
              localStorage.setItem('puml-layout:grid', e.target.checked ? 'on' : 'off');
            }}
          />
          Grid
        </label>
        <span className="sep" />
        <button className={showSource ? 'active' : ''} onClick={() => toggleSource()} title="Show the source and layout.json (S)">
          Source
        </button>
        <button onClick={exportSvg}>Export SVG</button>
        <span className="spacer" />
        {busy && <span className="busy">{busy}</span>}
        <span className="meta">
          {doc && `${doc.diagram.nodes.length} elements · ${doc.diagram.edges.length} lines · ${pinnedCount} pinned`}
          {staleCount > 0 && ` · ${staleCount} stale in layout.json`}
        </span>
        {doc && doc.warnings.length > 0 && (
          <button className="warn" onClick={() => setShowWarnings((s) => !s)}>
            {doc.warnings.length} warning{doc.warnings.length > 1 ? 's' : ''}
          </button>
        )}
        <span className={`status ${status}`}>{status === 'saving' ? 'saving…' : status === 'saved' ? 'saved' : status === 'error' ? 'save failed' : ''}</span>
      </header>
      {error && <div className="error">{error}</div>}
      {showWarnings && doc && (
        <div className="warnings">
          {doc.warnings.map((w, i) => (
            <div key={i}>
              line {w.line}: {w.message} <code>{w.text.trim()}</code>
            </div>
          ))}
        </div>
      )}
      <div className="workspace">
      <svg
        ref={svgRef}
        className="canvas"
        style={{ background: scene?.theme.colors.background }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="grid" width={20 * view.k} height={20 * view.k} x={view.x} y={view.y} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="#D9DCE1" />
          </pattern>
        </defs>
        {grid && <rect width="100%" height="100%" fill="url(#grid)" />}
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {frameBox && (
            <g className="frame">
              <rect x={frameBox.x} y={frameBox.y} width={frameBox.w} height={frameBox.h} fill={scene?.theme.colors.background} />
              <text x={frameBox.x} y={frameBox.y - 8}>
                {frame![0]}:{frame![1]}
              </text>
            </g>
          )}
          {scene && <DiagramContent scene={scene} ix={stableIx} />}
          {frameBox && <rect className="frame-border" x={frameBox.x} y={frameBox.y} width={frameBox.w} height={frameBox.h} />}
          {guides.map((g, i) =>
            g.axis === 'x' ? (
              <line key={i} x1={g.value} x2={g.value} y1={-big} y2={big} className="guide" />
            ) : (
              <line key={i} y1={g.value} y2={g.value} x1={-big} x2={big} className="guide" />
            ),
          )}
          {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} className="marquee" />}
        </g>
      </svg>
      {showSource && doc && (
        <SourcePanel
          file={doc.file}
          source={doc.source}
          layoutJson={serializeLayout(layout)}
          highlighted={highlightedLines}
          onLineClick={selectLine}
          onClose={() => toggleSource(false)}
        />
      )}
      </div>
      <footer className="help">
        Drag elements · drag a box title to move the box · pull a line to bend it, double-click a bend to remove it · drag labels ·
        shift-click / shift-drag to multi-select · Alt disables snapping · drag background to pan, pinch or ⌘-scroll to zoom · U unpin
        · ⌘Z undo
      </footer>
    </div>
  );
}
