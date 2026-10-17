import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { perf } from './perf.ts';
import { SourcePanel } from './SourcePanel.tsx';
import { Popover } from './Popover.tsx';
import { renderToStaticMarkup } from 'react-dom/server';
import { ensureLayout, hasSourceLayout, type LayoutMode } from '../layout/auto.ts';
import { emptyLayout, pageLayout, parseLayout, serializeLayout, withPageLayout, type LayoutFile, type Point } from '../layout/layout-file.ts';
import { parseDiagram } from '../model/diagram.ts';
import type { Diagram, ParseWarning } from '../model/types.ts';
import { AnyContent, DiagramSvg, type Interaction } from '../render/DiagramSvg.tsx';
import { buildAnyScene, type AnyScene } from '../scene/any.ts';
import { sourceItems } from '../model/items.ts';
import type { Avoid } from '../scene/avoid.ts';
import { ancestry, type Box } from '../scene/containers.ts';
import { FRAME_PRESETS, frameRect } from '../scene/frame.ts';
import { THEMES } from '../scene/theme.ts';
import { fitToFrame } from '../layout/fit.ts';
import { largestScale } from '../layout/scale.ts';
import { convert, formatOf as sourceFormatOf, TARGET_EXTENSION, type ConvertResult, type ConvertTarget } from '../convert/index.ts';

const SIZES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
import { alignmentSnap, clearVia, insertVia, moveNodes, moveSelection, moveVia, removeVia, setLabelOffset, setPinned, sidecarName, viaOf, type Guide } from './edits.ts';
import { addAll, boxFrom, clickSelect, marqueeSelect } from './selection.ts';
import { FilePicker } from './FilePicker.tsx';

interface Doc {
  file: string;
  source: string;
  diagram: Diagram;
  warnings: ParseWarning[];
  /** A recognised type with no layout model (`Pie`, `Salt (wireframe)`): shown as a panel, no sidecar. */
  unsupported?: string;
  /** Multi-page draw.io: every page, and the index of the one on screen. */
  pages?: { key: string; name: string }[];
  page?: number;
}

/** −/+ stepper; clicking the value resets to 100%. */
function Stepper({ label, value, onChange, title }: { label: string; value: number; onChange(v: number): void; title: string }) {
  const step = (d: number) => onChange(Math.min(3, Math.max(0.5, Math.round((value + d) * 10) / 10)));
  return (
    <span className="stepper" title={title} role="group" aria-label={`${label} size`}>
      <span className="stepper-label" aria-hidden="true">
        {label}
      </span>
      <button className="stepper-step" onClick={() => step(-0.1)} aria-label={`Smaller ${label.toLowerCase()}`}>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M0 4h8" />
        </svg>
      </button>
      <button className="stepper-value" onClick={() => onChange(1)} title="Reset to 100%">
        {Math.round(value * 100)}%
      </button>
      <button className="stepper-step" onClick={() => step(0.1)} aria-label={`Larger ${label.toLowerCase()}`}>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M0 4h8M4 0v8" />
        </svg>
      </button>
    </span>
  );
}

const TARGET_LABEL: Record<ConvertTarget, string> = { drawio: 'draw.io', puml: 'PlantUML', mermaid: 'Mermaid' };

/** A refusal, short enough for the menu's hint column (the full text is the row's tooltip). */
function shortReason(reason: string): string {
  const drawio = /^(\w+) diagrams can't be converted to draw\.io yet/.exec(reason);
  if (drawio) return `no ${drawio[1]!.toLowerCase()} in draw.io yet`;
  const mermaid = /^Mermaid has no (\w+) diagrams/.exec(reason);
  if (mermaid) return `no ${mermaid[1]} in Mermaid`;
  return reason.split(/[;:]/)[0]!;
}

/**
 * The losses of the conversion under the pointer, listed under the menu: what
 * the target can't hold, before anything is written. Empty until a target is
 * pointed at or focused.
 */
function ConvertLosses({ result, target }: { result?: ConvertResult; target: ConvertTarget | null }) {
  if (!result || !target || !result.source) return null;
  const shown = result.warnings.slice(0, 5);
  return (
    <div className="menu-detail" aria-live="polite">
      {result.warnings.length ? (
        <>
          <span className="field-label">What {TARGET_LABEL[target]} can't hold</span>
          <ul>
            {shown.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
          {result.warnings.length > shown.length && <span className="menu-more">+ {result.warnings.length - shown.length} more (in the tooltip)</span>}
        </>
      ) : (
        <span className="menu-more">Nothing reported lost.</span>
      )}
    </div>
  );
}

/** Nothing to arrange: a recognised-but-unsupported type, or a file without elements. */
function isBlank(diagram: Diagram, unsupported?: string): boolean {
  return !!unsupported || (!diagram.special && diagram.nodes.length === 0 && diagram.containers.length === 0);
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1 1l8 8M9 1 1 9" />
    </svg>
  );
}

/**
 * What the canvas shows when there is nothing to arrange: a type we recognise
 * but have no layout model for, or a file without elements. Says why and that
 * nothing was written, instead of leaving an empty grid that looks broken.
 */
function BlankPanel({ doc, onWarnings }: { doc: Doc; onWarnings(): void }) {
  const name = doc.file.split('/').pop();
  return (
    <div className="blank-panel" role="status" data-blank={doc.unsupported ? 'unsupported' : 'empty'}>
      <span className="blank-glyph" aria-hidden="true" />
      <h2>{doc.unsupported ? `${doc.unsupported} diagrams aren't supported yet` : 'Nothing to lay out'}</h2>
      <p>
        {doc.unsupported ? (
          <>
            <code>{name}</code> is recognised, but there is no layout model for this type, so there is nothing to arrange.
          </>
        ) : (
          <>
            No elements were found in <code>{name}</code>.{' '}
            {doc.warnings.length > 0 && (
              <>
                {doc.warnings.length} line{doc.warnings.length > 1 ? 's were' : ' was'} not understood:{' '}
                <button className="link" onClick={onWarnings}>
                  show warnings
                </button>
                .
              </>
            )}
          </>
        )}
      </p>
      <p className="blank-note">The file is untouched and no layout.json was written. It reloads here as soon as it changes on disk.</p>
      <p className="blank-supported">
        <span className="field-label">Supported</span>
        PlantUML: use case, component, deployment, class, object, ER, state, activity, sequence, timing, Gantt, C4, mindmap, WBS, JSON, YAML, Chen, ArchiMate,
        nwdiag · Mermaid: flowchart, sequence, class, state, ER, Gantt, mindmap · draw.io
      </p>
    </div>
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
      /** Fixed for the whole drag: what to re-route, and what to snap against. */
      dirtyNodes: ReadonlySet<string>;
      others: { x: number; y: number }[];
      moved: boolean;
    }
  | { kind: 'edge'; id: string; start: Point; before: LayoutFile }
  | { kind: 'via'; id: string; index: number; before: LayoutFile; base: LayoutFile; moved: boolean }
  | { kind: 'label'; id: string; start: Point; origin: Point; before: LayoutFile; moved: boolean }
  | { kind: 'pan'; client: Point; origin: View; moved: boolean }
  | { kind: 'marquee'; start: Point; client: Point; additive: boolean; base: ReadonlySet<string>; box: Box | null };

const DRAG_THRESHOLD = 3;
const SNAP = 6;

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

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
  /** draw.io page id (`?page=`); undefined = the first page, whose layout is the sidecar's top level. */
  const [page, setPage] = useState<string | undefined>(() => new URLSearchParams(location.search).get('page') ?? undefined);
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
  /** Space held (ready to pan) or a pan in progress: drives the grab cursor. */
  const [panning, setPanning] = useState(false);
  const spaceHeld = useRef(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  /** While dragging: what moved, so only its lines are re-routed. Null means a full build. */
  const dirty = useRef<{ nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | null>(null);
  const previousScene = useRef<AnyScene | null>(null);
  const undoStack = useRef<LayoutFile[]>([]);
  const redoStack = useRef<LayoutFile[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /**
   * The whole sidecar as last read or written, other draw.io pages included.
   * `layout` is only the page on screen; saving merges it back in here.
   */
  const sidecarRef = useRef<LayoutFile>(emptyLayout());
  /** Sidecar key of the page on screen (undefined: the top level). Set by load, read by save. */
  const pageKeyRef = useRef<string | undefined>(undefined);
  const pageRef = useRef(page);
  pageRef.current = page;
  /** The full sidecar with `next` as the current page: what is written, exported and shown in Source. */
  const sidecarWith = useCallback((next: LayoutFile) => withPageLayout(sidecarRef.current, pageKeyRef.current, next), []);
  const fileRef = useRef(file);
  fileRef.current = file;
  const viewRef = useRef(view);
  viewRef.current = view;
  const saveTimer = useRef<number | undefined>(undefined);
  const needsFit = useRef(true);
  /** True while the view is still the one Fit view chose: a window resize then refits instead of cropping. */
  const autoFit = useRef(true);

  /** The debounced write not yet sent. Opening another file or page sends it first (see `load`). */
  const pendingSave = useRef<{ target: string; body: string } | null>(null);

  const writePending = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const p = pendingSave.current;
    if (!p) return;
    pendingSave.current = null;
    try {
      const res = await fetch(`/api/layout?file=${encodeURIComponent(p.target)}`, { method: 'PUT', body: p.body });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
    }
  }, []);

  const save = useCallback(
    (next: LayoutFile) => {
      const target = fileRef.current;
      if (!target) return;
      setStatus('saving');
      // Merge now, not when the timer fires: a page switch in between must not file this page under the next one.
      const full = sidecarWith(next);
      sidecarRef.current = full;
      if (pendingSave.current && pendingSave.current.target !== target) void writePending();
      pendingSave.current = { target, body: serializeLayout(full) };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void writePending(), 250);
    },
    [sidecarWith, writePending],
  );

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
        // Each phase is timed so a slow open can be pinned on fetch, parse or ELK (`__perf.summary()`).
        const t0 = performance.now();
        // A page switch re-reads the sidecar: the last edit must be on disk first, or it would be read back stale.
        await writePending();
        const res = await fetch(`/api/doc?file=${encodeURIComponent(target)}`);
        if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
        const body = (await res.json()) as { source: string; layout: string | null };
        const t1 = performance.now();
        perf.record('open: fetch', t1 - t0);
        const parsed = parseDiagram(body.source, target, { page: pageRef.current });
        const t2 = performance.now();
        perf.record('open: parse', t2 - t1);
        // The first page lives at the sidecar's top level; others under `pages` by key.
        const pageKey = parsed.pages && parsed.page ? parsed.pages[parsed.page]!.key : undefined;
        let base = layoutRef.current;
        if (what !== 'source') {
          try {
            sidecarRef.current = parseLayout(body.layout ?? '');
          } catch {
            setError('layout.json is not valid JSON, ignoring it until it is fixed');
            return;
          }
          base = pageLayout(sidecarRef.current, pageKey);
        }
        pageKeyRef.current = pageKey;
        const next = await ensureLayout(parsed.diagram, base, 'fill');
        perf.record(body.layout ? 'open: layout (sidecar)' : 'open: layout (first)', performance.now() - t2);
        if (what === 'all') {
          perf.openedAt = t0;
          undoStack.current = [];
          redoStack.current = [];
          setSelNodes(new Set());
          setSelEdge(undefined);
          needsFit.current = true;
        } else {
          undoStack.current.push(layoutRef.current);
        }
        setDoc({ file: target, source: body.source, diagram: parsed.diagram, warnings: parsed.warnings, unsupported: parsed.unsupported, pages: parsed.pages, page: parsed.page });
        setLayout(next);
        setError(null);
        // Nothing to place, nothing to remember: a blank file gets no sidecar.
        if (!isBlank(parsed.diagram, parsed.unsupported) && serializeLayout(sidecarWith(next)) !== (body.layout ?? '')) save(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [save, sidecarWith, writePending],
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
    if (page === undefined) url.searchParams.delete('page');
    else url.searchParams.set('page', page);
    history.replaceState(null, '', url);
    void load(file);
  }, [file, page, load]);

  /** Another diagram starts on its first page. */
  const pickFile = useCallback((next: string) => {
    setPage(undefined);
    setFile(next);
  }, []);

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

  const scene: AnyScene | null = useMemo(() => {
    if (!doc) return null;
    try {
      const t0 = performance.now();
      const prev = previousScene.current;
      const fast = dirty.current && prev?.kind === 'graph' ? { previous: prev, dirty: dirty.current } : {};
      const built = buildAnyScene(doc.diagram, layout, avoid, fast);
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
    const opened = perf.openedAt;
    if (opened !== undefined && scene) {
      perf.openedAt = undefined;
      perf.record('open: total', performance.now() - opened);
    }
    const start = perf.inputAt;
    if (start === undefined) return;
    perf.inputAt = undefined;
    perf.record('commit', performance.now() - start);
    requestAnimationFrame(() => requestAnimationFrame(() => perf.record('frame', performance.now() - start)));
  }, [scene]);

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  /** Nothing to arrange: an unsupported type, or a file without elements. The canvas shows a panel instead. */
  const blank = !!doc && isBlank(doc.diagram, doc.unsupported);

  const frame = layout.view?.frame;
  const frameBox = useMemo(() => (scene && frame ? frameRect(scene.bounds, frame) : null), [scene, frame]);

  const fit = useCallback(() => {
    const svg = svgRef.current;
    if (!scene || !svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const b = frameBox ?? scene.bounds;
    const k = Math.min(2, (width - 80) / Math.max(b.w, 1), (height - 80) / Math.max(b.h, 1));
    setView({ k, x: (width - b.w * k) / 2 - b.x * k, y: (height - b.h * k) / 2 - b.y * k });
    autoFit.current = true;
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
    const diagram = doc!.diagram;
    // Sequence columns have no stored position until dragged; start from where the layout put them.
    const columns = sceneRef.current?.kind === 'sequence' ? sceneRef.current.columns : {};
    const at = (id: string) => l.nodes[id] ?? (columns[id] !== undefined ? { x: columns[id]!, y: 0 } : undefined);
    const origin = Object.fromEntries(ids.filter((id) => at(id)).map((id) => [id, { x: at(id)!.x, y: at(id)!.y }]));
    const moving = new Set(ids);
    const parents = new Map(diagram.nodes.map((n) => [n.id, n.parent]));
    // Lines that end on an enclosing container move with its border, so they count as dirty too.
    const dirtyNodes = new Set([...ids, ...ids.flatMap((id) => ancestry(diagram, parents.get(id)))]);
    const others = diagram.nodes.flatMap((n) => (!moving.has(n.id) && l.nodes[n.id] ? [l.nodes[n.id]!] : []));
    drag.current = { kind: 'nodes', ids, primary, start: toDiagram(e.clientX, e.clientY), before: l, origin, originVia: viaOf(l), dirtyNodes, others, moved: false };
    capture(e);
  };

  /** Free (graph) diagrams take multi-selection and marquee; ordered ones keep one element at a time. */
  const multi = scene?.kind === 'graph';

  const ix: Interaction = {
    selectedNodes: selNodes,
    selectedEdge: selEdge,
    showPins: true,
    onNodeDown(id, e) {
      if (e.button !== 0 || spaceHeld.current) return; // Space-drag pans, even over elements
      e.stopPropagation();
      const selection = clickSelect(selNodes, id, e.shiftKey || e.metaKey || e.ctrlKey, multi);
      setSelNodes(selection);
      setSelEdge(undefined);
      if (selection.has(id)) startNodeDrag([...selection], id, e);
    },
    onContainerDown(id, e) {
      if (e.button !== 0 || !doc || spaceHeld.current) return;
      e.stopPropagation();
      const contents = descendants(doc.diagram, id);
      if (!contents.length) return;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const selection = addAll(selNodes, contents, additive);
      setSelNodes(selection);
      setSelEdge(undefined);
      startNodeDrag([...selection], contents[0]!, e);
    },
    onEdgeDown(id, e) {
      if (e.button !== 0 || spaceHeld.current) return; // Space-drag pans, even over elements
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
      if (e.button !== 0 || spaceHeld.current) return; // Space-drag pans, even over elements
      e.stopPropagation();
      setSelEdge(id);
      setSelNodes(new Set());
      const l = layoutRef.current;
      drag.current = { kind: 'label', id, start: toDiagram(e.clientX, e.clientY), origin: l.edges[id]?.label ?? [0, 0], before: l, moved: false };
      capture(e);
    },
    onViaDown(id, index, e) {
      if (e.button !== 0 || spaceHeld.current) return; // Space-drag pans, even over elements
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

  /**
   * Empty canvas: drag = marquee on free diagrams; Space-drag, middle button,
   * or any drag on ordered diagrams = pan. Two-finger scroll pans everywhere.
   */
  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && multi && !spaceHeld.current) {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      drag.current = { kind: 'marquee', start: toDiagram(e.clientX, e.clientY), client: [e.clientX, e.clientY], additive, base: selNodes, box: null };
    } else {
      e.preventDefault(); // middle button: no autoscroll
      drag.current = { kind: 'pan', client: [e.clientX, e.clientY], origin: viewRef.current, moved: false };
      setPanning(true);
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
        const ordered = sceneRef.current?.kind === 'sequence';
        if (ordered) dy = 0; // columns only move sideways
        if (primary && !e.altKey && !ordered) {
          const snap = alignmentSnap({ x: primary.x + dx, y: primary.y + dy }, d.others, SNAP / k);
          dx += snap.dx;
          dy += snap.dy;
          setGuides(snap.guides);
        } else {
          setGuides([]);
        }
        dirty.current = { nodes: d.dirtyNodes, edges: new Set() };
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
        autoFit.current = false;
        setView({ ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy });
        break;
      }
      case 'marquee':
        if (!d.box && Math.hypot(e.clientX - d.client[0], e.clientY - d.client[1]) < DRAG_THRESHOLD) return;
        d.box = boxFrom(d.start, p);
        setMarquee(d.box);
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
        setPanning(spaceHeld.current);
        if (!d.moved) {
          setSelNodes(new Set());
          setSelEdge(undefined);
        }
        break;
      case 'marquee': {
        const s = sceneRef.current;
        if (d.box && s?.kind === 'graph') {
          setSelNodes(marqueeSelect(d.base, s.nodes.map((n) => ({ id: n.node.id, box: n.box })), d.box, d.additive));
        } else if (!d.additive) {
          setSelNodes(new Set()); // a plain click on empty canvas clears
        }
        setSelEdge(undefined);
        setMarquee(null);
        break;
      }
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
      autoFit.current = false;
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
      // draw.io files carry their own layout; Reset goes back to it rather than to ELK.
      const fromFile = hasSourceLayout(doc.diagram);
      if (mode === 'reset' && !confirm(fromFile ? "Discard all positions, pins and bends, and go back to the file's layout?" : 'Discard all positions, pins and bends, and lay out from scratch?')) return;
      commit(await ensureLayout(doc.diagram, layoutRef.current, mode));
    },
    [doc, commit],
  );

  const updateViewSettings = useCallback(
    (patch: { theme?: string; frame?: Point | null; scale?: number; text?: number; icons?: number; spacing?: Point }) => {
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
      if (patch.spacing) {
        if (patch.spacing[0] === 1 && patch.spacing[1] === 1) delete view.spacing;
        else view.spacing = patch.spacing;
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

  // Window resizes keep the diagram fitted until the user pans or zooms; after that the view is theirs.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let frameId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => autoFit.current && fitRef.current());
    });
    observer.observe(svg);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, []);

  /** Source lines of the selection: element declarations and the relations of a selected line. */
  const highlightedLines = useMemo(() => {
    const lines = new Set<number>();
    if (!doc) return lines;
    const items = sourceItems(doc.diagram);
    for (const n of items.nodes) if (selNodes.has(n.id)) lines.add(n.line);
    const edge = items.edges.find((e) => e.id === selEdge);
    if (edge) lines.add(edge.line);
    return lines;
  }, [doc, selNodes, selEdge]);

  const selectLine = useCallback(
    (line: number) => {
      if (!doc) return;
      const items = sourceItems(doc.diagram);
      const nodes = items.nodes.filter((n) => n.line === line).map((n) => n.id);
      const edge = items.edges.find((e) => e.line === line);
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

  const baseName = doc ? doc.file.split('/').pop()!.replace(/\.\w+$/, '') : 'diagram';

  /** Shows a short message in the readout for a few seconds. */
  const flash = useCallback((message: string) => {
    setBusy(message);
    window.setTimeout(() => setBusy((b) => (b === message ? null : b)), 3000);
  }, []);

  const exportSvg = useCallback(() => {
    if (!scene) return;
    download(new Blob([renderToStaticMarkup(<DiagramSvg scene={scene} frame={frame} />)], { type: 'image/svg+xml' }), `${baseName}.svg`);
  }, [scene, frame, baseName]);

  /** PNG at up to 2x, rasterised by the browser from the same SVG the SVG export writes. */
  const exportPng = useCallback(async () => {
    if (!scene) return;
    const markup = renderToStaticMarkup(<DiagramSvg scene={scene} frame={frame} />);
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      await img.decode();
      // Browsers refuse canvases much past 16k px a side; large scaled layouts get less than 2x.
      const k = Math.min(2, 8192 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error(`canvas of ${canvas.width}×${canvas.height} px could not be encoded`);
      download(blob, `${baseName}.png`);
    } catch (e) {
      setError(`PNG export failed: ${String(e)}`);
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }, [scene, frame, baseName]);

  /** The sidecar exactly as the editor saves it, under the sidecar's own name. */
  const exportLayout = useCallback(() => {
    if (!doc) return;
    download(new Blob([serializeLayout(sidecarWith(layoutRef.current))], { type: 'application/json' }), sidecarName(doc.file));
  }, [doc, sidecarWith]);

  /**
   * The diagram in another format, as downloads: draw.io carries the layout
   * in the file; PlantUML/Mermaid come with their own sidecar. Named
   * `name-<format>` so a copy dropped next to the original never shares its
   * layout.json.
   */
  /**
   * Every conversion, run when the Export menu opens (a few ms each): the menu
   * disables targets that can't hold the diagram, with the reason, and shows
   * each target's losses before anything is downloaded.
   */
  const [conversions, setConversions] = useState<Record<ConvertTarget, ConvertResult> | null>(null);
  const [convertFocus, setConvertFocus] = useState<ConvertTarget | null>(null);
  const previewConversions = useCallback(
    (open: boolean) => {
      setConvertFocus(null);
      if (!open || !doc || blank) return setConversions(null);
      const all = {} as Record<ConvertTarget, ConvertResult>;
      for (const target of ['drawio', 'puml', 'mermaid'] as const) {
        try {
          all[target] = convert(doc.diagram, layoutRef.current, target, scene ?? undefined);
        } catch (e) {
          all[target] = { source: '', layout: emptyLayout(), warnings: [{ line: 0, text: '', message: `Conversion failed: ${String(e)}` }], ids: { nodes: {}, edges: {} } };
        }
      }
      setConversions(all);
    },
    [doc, blank, scene],
  );

  const exportConverted = useCallback(
    (target: ConvertTarget) => {
      if (!doc) return;
      const result = conversions?.[target] ?? convert(doc.diagram, layoutRef.current, target, scene ?? undefined);
      if (!result.source) {
        setError(result.warnings.map((w) => w.message).join('; '));
        return;
      }
      const stem = `${baseName}-${target}`;
      download(new Blob([result.source], { type: 'text/plain' }), `${stem}${TARGET_EXTENSION[target]}`);
      // Browsers drop a second download started in the same tick.
      if (target !== 'drawio') window.setTimeout(() => download(new Blob([serializeLayout(result.layout)], { type: 'application/json' }), `${stem}.layout.json`), 300);
      if (result.warnings.length) {
        console.warn(result.warnings.map((w) => w.message).join('\n'));
        flash(`Converted with ${result.warnings.length} approximation${result.warnings.length > 1 ? 's' : ''}`);
      } else flash(`Converted to ${TARGET_LABEL[target]}`);
    },
    [doc, scene, baseName, flash, conversions],
  );

  const copyLayout = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(serializeLayout(sidecarWith(layoutRef.current)));
      flash('Copied layout.json');
    } catch (e) {
      setError(`Copy failed: ${String(e)}`);
    }
  }, [flash, sidecarWith]);

  const importInput = useRef<HTMLInputElement>(null);
  /** Replaces the layout with a file's, as one undoable step; elements it doesn't place are laid out. */
  const importLayout = useCallback(
    async (picked: File | undefined) => {
      if (!picked || !doc) return;
      try {
        // A whole sidecar brings this page's entry if it has one; a single-page file is taken as this page.
        const imported = parseLayout(await picked.text());
        const key = pageKeyRef.current;
        const next = await ensureLayout(doc.diagram, key && imported.pages?.[key] ? pageLayout(imported, key) : pageLayout(imported), 'fill');
        commit(next);
        needsFit.current = true;
        flash(`Imported ${picked.name}`);
      } catch (e) {
        setError(`Import failed: ${String(e)}`);
      }
    },
    [doc, commit, flash],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a' && doc && sceneRef.current?.kind === 'graph') {
        e.preventDefault();
        setSelNodes(new Set(doc.diagram.nodes.map((n) => n.id)));
        setSelEdge(undefined);
        return;
      }
      if (e.key === 'Escape') {
        setShowWarnings(false);
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
        commit(moveSelection(layoutRef.current, doc.diagram, selNodes, arrow[0] * step, arrow[1] * step));
      }
    };
    // Space held = pan mode (like design tools). Not while a key or field has focus: Space presses buttons there.
    const isControl = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('button, input, select, textarea');
    const onSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isControl(e.target)) return;
      e.preventDefault();
      const down = e.type === 'keydown';
      if (spaceHeld.current === down) return;
      spaceHeld.current = down;
      if (!drag.current) setPanning(down);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSpace);
    window.addEventListener('keyup', onSpace);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSpace);
      window.removeEventListener('keyup', onSpace);
    };
  }, [doc, selNodes, selEdge, commit, undo, redo, fit, toggleSource]);

  const pinnedCount = doc ? doc.diagram.nodes.filter((n) => layout.nodes[n.id]?.pinned).length : 0;
  const staleCount = doc ? Object.keys(layout.nodes).filter((id) => !doc.diagram.nodes.some((n) => n.id === id)).length : 0;
  const big = 1e5;
  const spacing = layout.view?.spacing ?? [1, 1];
  // Dots closer than 12px read as a grey mesh: switch to a 5x coarser grid, then hide it.
  const gridStep = 20 * view.k >= 12 ? 20 : 100 * view.k >= 12 ? 100 : 0;
  // Dots are a faint mix of the theme's ink into its paper, so dark themes don't get a field of bright pins.
  const gridDot = scene ? `color-mix(in srgb, ${scene.theme.colors.text} 16%, ${scene.theme.colors.background})` : '#CFCBC2';

  return (
    // `data-loaded` names the file whose scene is on screen (`data-page` its draw.io page): the browser scripts wait on them (scripts/cdp.mjs open()).
    <div className="app" data-loaded={doc?.file} data-page={doc?.pages?.[doc.page ?? 0]?.key}>
      <header className="toolbar">
        <div className="nameplate" aria-label="puml layout">
          <span className="nameplate-name">puml</span>
          <span className="nameplate-model">Layout</span>
        </div>
        <FilePicker files={files} file={file} onPick={pickFile} />
        {doc?.pages && (
          <select
            className="page-select"
            value={doc.pages[doc.page ?? 0]!.key}
            onChange={(e) => setPage(e.target.selectedIndex === 0 ? undefined : e.target.value)}
            title="draw.io page: each page has its own layout in layout.json"
            aria-label="Page"
          >
            {doc.pages.map((p, i) => (
              <option key={p.key} value={p.key}>
                {i + 1}/{doc.pages!.length} · {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="sep" aria-hidden="true" />
        <div className="keys joined" role="group" aria-label="Layout">
          <button disabled={blank} onClick={() => void runLayout('auto')} title="Re-layout everything you haven't placed by hand">
            Auto<span className="wide-only"> layout</span>
          </button>
          <button disabled={blank} onClick={() => void runLayout('reset')} title={doc && hasSourceLayout(doc.diagram) ? "Discard the layout and go back to the file's" : 'Discard the layout and start over'}>
            Reset
          </button>
          <button className="selection-key" disabled={!selNodes.size} onClick={() => commit(setPinned(layoutRef.current, selNodes, false))} title="Unpin selected (U)">
            Unpin
          </button>
          <button className="selection-key" disabled={!selEdge} onClick={() => selEdge && commit(clearVia(layoutRef.current, selEdge))} title="Remove bends from the selected line (Delete)">
            Straighten
          </button>
        </div>
        <div className="keys joined" role="group" aria-label="History">
          <button className="icon" onClick={undo} title="Undo (⌘Z)" aria-label="Undo">
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
              <path d="M4.5 1 1 4.5 4.5 8M1 4.5h8a4 4 0 0 1 0 8H7" />
            </svg>
          </button>
          <button className="icon" onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo">
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
              <path d="M9.5 1 13 4.5 9.5 8M13 4.5H5a4 4 0 0 0 0 8h2" />
            </svg>
          </button>
        </div>
        <span className="sep" aria-hidden="true" />
        <div className="keys" role="group" aria-label="Frame and fit">
          <select
            className="frame-select"
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
            aria-label="Frame"
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
        </div>
        <span className="sep" aria-hidden="true" />
        <div className="keys" role="group" aria-label="View">
          <Popover label="Display" title="Theme, size, text and icon scale, grid" className="display">
            <div className="field">
              <span className="field-label">Theme</span>
              <select className="theme-select" value={layout.view?.theme ?? 'classic'} onChange={(e) => updateViewSettings({ theme: e.target.value })} title="Theme">
                {Object.values(THEMES).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">Size</span>
              <select
                className="size-select"
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
                    {Math.round(v * 100)}%
                  </option>
                ))}
                {!doc?.diagram.special && <option value="max">Largest that fits</option>}
              </select>
            </div>
            <div className="field">
              <span className="field-label">Scale</span>
              <span className="field-keys">
                <Stepper label="Text" value={layout.view?.text ?? 1} onChange={(v) => updateViewSettings({ text: v })} title="Text size, on top of Size" />
                <Stepper label="Icons" value={layout.view?.icons ?? 1} onChange={(v) => updateViewSettings({ icons: v })} title="Actor and system icon size, on top of Size" />
              </span>
            </div>
            {doc?.diagram.special && (
              <div className="field">
                <span className="field-label">Gaps</span>
                <span className="field-keys">
                  <Stepper label="Across" value={spacing[0]} onChange={(v) => updateViewSettings({ spacing: [v, spacing[1]] })} title="Column (or time) gap" />
                  <Stepper label="Down" value={spacing[1]} onChange={(v) => updateViewSettings({ spacing: [spacing[0], v] })} title="Row gap" />
                </span>
              </div>
            )}
            <div className="field">
              <span className="field-label">Canvas</span>
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
            </div>
          </Popover>
          <button className="fit-view" onClick={fit} title="Fit the diagram to the window (F)" aria-label="Fit view">
            <span className="wide-only">Fit view</span>
            <svg className="narrow-only" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
            </svg>
          </button>
          <button className={`switch${showSource ? ' active' : ''}`} aria-pressed={showSource} onClick={() => toggleSource()} title="Show the source and layout.json (S)">
            <span className="lamp" aria-hidden="true" />
            Source
          </button>
        </div>
        <div className="readout">
          {busy && (
            <span className="busy" role="status" title={busy}>
              {busy}
            </span>
          )}
          {doc && !blank && (
            <span className="meta" title={`${doc.diagram.nodes.length} elements, ${doc.diagram.edges.length} lines, ${pinnedCount} pinned${staleCount ? `, ${staleCount} stale ids in layout.json` : ''}`}>
              {selNodes.size > 1 && (
                <span className="cell selected">
                  <span className="num">{selNodes.size}</span> selected
                </span>
              )}
              <span className="cell total">
                <span className="num">{doc.diagram.nodes.length}</span> elements
              </span>
              <span className="cell total">
                <span className="num">{doc.diagram.edges.length}</span> lines
              </span>
              <span className="cell">
                <span className="num">{pinnedCount}</span> pinned
              </span>
              {staleCount > 0 && (
                <span className="cell stale">
                  <span className="num">{staleCount}</span> stale
                </span>
              )}
            </span>
          )}
        </div>
        {/* Warnings and save state never shrink away with the readout: they are the lamps that matter. */}
        <div className="lamps">
          {doc && doc.warnings.length > 0 && (
            <button className="warn" aria-expanded={showWarnings} onClick={() => setShowWarnings((s) => !s)}>
              <svg className="glyph" width="12" height="11" viewBox="0 0 12 11" aria-hidden="true">
                <path d="M6 0.5 11.5 10.5H0.5Z" />
              </svg>
              {doc.warnings.length}
            </button>
          )}
          <span className={`status ${status}`} role="status" title={status === 'saved' ? 'layout.json saved' : undefined}>
            {status === 'saving' ? 'saving' : status === 'saved' ? 'saved' : status === 'error' ? 'save failed' : ''}
          </span>
        </div>
        <div className="keys split" role="group" aria-label="Export">
          <button className="primary" disabled={blank} onClick={exportSvg} title="Download the laid-out diagram as SVG">
            Export<span className="wide-only"> SVG</span>
          </button>
          <Popover
            label={<span className="sr-only">More export</span>}
            title="More export: PNG, layout.json, convert to draw.io / PlantUML / Mermaid"
            className="export-menu"
            align="right"
            disabled={blank}
            onOpenChange={previewConversions}
          >
            {(close) => (
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => (close(), exportSvg())}>
                  SVG <span className="hint">{baseName}.svg</span>
                </button>
                <button role="menuitem" onClick={() => (close(), void exportPng())}>
                  PNG <span className="hint">≤ 2×</span>
                </button>
                <span className="menu-rule" aria-hidden="true" />
                <button role="menuitem" data-action="export-layout" onClick={() => (close(), exportLayout())}>
                  Layout JSON <span className="hint">{doc ? sidecarName(doc.file) : ''}</span>
                </button>
                <button role="menuitem" data-action="copy-layout" onClick={() => (close(), void copyLayout())}>
                  Copy layout JSON
                </button>
                <button role="menuitem" data-action="import-layout" onClick={() => (close(), importInput.current?.click())}>
                  Import layout JSON… <span className="hint">undoable</span>
                </button>
                <span className="menu-rule" aria-hidden="true" />
                {(['drawio', 'puml', 'mermaid'] as const).map((target) => {
                  const result = conversions?.[target];
                  const reason = result && !result.source ? result.warnings.map((w) => w.message).join('; ') : undefined;
                  const losses = result?.source ? result.warnings.length : 0;
                  const same = doc && sourceFormatOf(doc.file, doc.source) === target;
                  return (
                    // A disabled button gets no hover events in every browser; the wrapper carries the reason's tooltip.
                    <span key={target} className="menu-item-wrap" title={reason ?? (losses ? result!.warnings.map((w) => `≈ ${w.message}`).join('\n') : undefined)}>
                      <button
                        role="menuitem"
                        data-action={`convert-${target}`}
                        data-losses={losses}
                        disabled={blank || !!reason}
                        onClick={() => (close(), exportConverted(target))}
                        onPointerEnter={() => setConvertFocus(target)}
                        onFocus={() => setConvertFocus(target)}
                      >
                        <span>Convert to {TARGET_LABEL[target]}</span>
                        <span className="hint">
                          {reason ? (
                            <span className="menu-reason">{shortReason(reason)}</span>
                          ) : losses ? (
                            <span className="menu-losses">
                              <svg className="glyph" width="10" height="9" viewBox="0 0 12 11" aria-hidden="true">
                                <path d="M6 0.5 11.5 10.5H0.5Z" />
                              </svg>
                              {losses}
                            </span>
                          ) : null}
                          {!reason && (same ? 'same format' : target === 'drawio' ? 'layout in file' : '+ layout.json')}
                        </span>
                      </button>
                    </span>
                  );
                })}
                <ConvertLosses result={convertFocus ? conversions?.[convertFocus] : undefined} target={convertFocus} />
              </div>
            )}
          </Popover>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              void importLayout(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <Popover label="?" title="Mouse and keyboard" className="help" align="right">
          <dl className="keymap">
            <dt>Move</dt>
            <dd>drag an element, label or box title; selection moves together</dd>
            <dt>Select</dt>
            <dd>click; <kbd>⇧</kbd>/<kbd>⌘</kbd> click to add or remove</dd>
            <dt>Marquee</dt>
            <dd>drag on empty canvas; <kbd>⇧</kbd> adds to the selection</dd>
            <dt>All / none</dt>
            <dd>
              <kbd>⌘A</kbd> / <kbd>Esc</kbd>
            </dd>
            <dt>Nudge</dt>
            <dd>
              arrows, <kbd>⇧</kbd> ×10
            </dd>
            <dt>Pan</dt>
            <dd>
              two-finger scroll, <kbd>Space</kbd> drag, middle button
            </dd>
            <dt>Zoom</dt>
            <dd>
              pinch, <kbd>⌘</kbd> scroll
            </dd>
            <dt>Bend</dt>
            <dd>pull a line; double-click a bend to remove</dd>
            <dt>No snap</dt>
            <dd>
              hold <kbd>Alt</kbd>
            </dd>
            <dt>Keys</dt>
            <dd>
              <kbd>U</kbd> unpin · <kbd>Del</kbd> straighten · <kbd>F</kbd> fit · <kbd>S</kbd> source · <kbd>⌘Z</kbd> undo
            </dd>
          </dl>
          <p className="keymap-note">Sequence, Gantt and timing select one element; drag on empty canvas pans.</p>
        </Popover>
      </header>
      <div className="workspace">
        <div className="stage">
        <svg
          ref={svgRef}
          className={`canvas${panning ? ' panning' : ''}${multi ? ' marquee-mode' : ''}`}
          style={{ background: scene?.theme.colors.background }}
          onPointerDown={onBackgroundDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <pattern id="grid" width={gridStep * view.k} height={gridStep * view.k} x={view.x} y={view.y} patternUnits="userSpaceOnUse">
              <circle cx={1} cy={1} r={1} style={{ fill: gridDot }} />
            </pattern>
          </defs>
          {grid && gridStep > 0 && <rect width="100%" height="100%" fill="url(#grid)" />}
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {frameBox && (
              <g className="frame">
                <rect x={frameBox.x} y={frameBox.y} width={frameBox.w} height={frameBox.h} fill={scene?.theme.colors.background} />
                <text x={frameBox.x} y={frameBox.y - 8}>
                  {frame![0]}:{frame![1]}
                </text>
              </g>
            )}
            {scene && <AnyContent scene={scene} ix={stableIx} />}
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
        {doc && blank && <BlankPanel doc={doc} onWarnings={() => setShowWarnings(true)} />}
        {/* Messages float over the canvas rather than push it down, so opening them never moves the diagram. */}
        <div className="notices">
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button className="notice-close" onClick={() => setError(null)} aria-label="Dismiss">
                <CloseGlyph />
              </button>
            </div>
          )}
          {showWarnings && doc && doc.warnings.length > 0 && (
            <div className="warnings" role="region" aria-label="Warnings">
              <div className="warnings-head">
                <span className="field-label">
                  {doc.warnings.length} warning{doc.warnings.length > 1 ? 's' : ''}
                </span>
                <span className="warnings-note">lines that were skipped or approximated; the file is never changed</span>
                <button className="notice-close" onClick={() => setShowWarnings(false)} aria-label="Close warnings">
                  <CloseGlyph />
                </button>
              </div>
              <ol className="warnings-list">
                {doc.warnings.map((w, i) => (
                  <li key={i}>
                    <span className="warnings-line">{w.line > 0 ? `line ${w.line}` : ''}</span>
                    <span>
                      {w.message}
                      {w.text.trim() && <code>{w.text.trim()}</code>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        </div>
        {showSource && doc && (
          <SourcePanel
            file={doc.file}
            source={doc.source}
            layoutJson={serializeLayout(sidecarWith(layout))}
            highlighted={highlightedLines}
            onLineClick={selectLine}
            onClose={() => toggleSource(false)}
          />
        )}
      </div>
    </div>
  );
}
