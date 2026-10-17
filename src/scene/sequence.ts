import type { LayoutFile } from '../layout/layout-file.ts';
import type { DNode, NodeKind, SeqEvent, SeqParticipant, SequenceModel } from '../model/types.ts';
import type { Box } from './containers.ts';
import { measureText, type TextBlock } from './measure.ts';
import type { SceneNode } from './scene.ts';
import { nodeShape } from './shapes.ts';
import { themeOf, type Theme } from './theme.ts';

/**
 * Sequence layout. Participants are columns, events are rows, so the only
 * free choices are the column positions (stored per participant in
 * layout.json when dragged) and the gaps (`view.spacing`). Everything else
 * follows from the order of events in the source.
 */

type Message = Extract<SeqEvent, { type: 'message' }>;

export interface SeqMessage {
  e: Message;
  x1: number;
  x2: number;
  y: number;
  self: boolean;
  label?: { text: TextBlock; x: number; y: number; align: 'middle' | 'start' };
  /**
   * Modern themes: the autonumber as a bubble left of the label (PlantUML
   * keeps it inline in the text). `x` is the bubble centre.
   */
  number?: { text: string; x: number; y: number; r: number };
}

export interface SequenceScene {
  kind: 'sequence';
  theme: Theme;
  heads: SceneNode[];
  feet: SceneNode[];
  lifelines: { id: string; x: number; y0: number; y1: number }[];
  activations: Box[];
  messages: SeqMessage[];
  notes: { box: Box; text: TextBlock; line: number }[];
  groups: { kind: string; label: TextBlock; box: Box; elses: { y: number; label?: TextBlock }[]; line: number }[];
  dividers: { y: number; x0: number; x1: number; label: TextBlock }[];
  delays: { y0: number; y1: number; label?: TextBlock; x: number }[];
  refs: { box: Box; text: TextBlock }[];
  boxes: { box: Box; label: TextBlock }[];
  destroys: { x: number; y: number }[];
  /** Column centre per participant, for dragging. */
  columns: Record<string, number>;
  bounds: Box;
}

const HEAD_KIND: Record<string, NodeKind> = {
  participant: 'rectangle',
  actor: 'actor',
  boundary: 'boundary',
  control: 'control',
  entity: 'entity',
  database: 'database',
  collections: 'collections',
  queue: 'queue',
};

/** Diameter (plus an 8px gap) of an autonumber bubble: fits the digits, never narrower than a circle. */
function bubbleSizeFor(theme: Theme) {
  return (n: string) => Math.max(theme.size.edge * 1.45, measureText(n, theme.size.edge * 0.82, true, theme.widthFactor).width + theme.size.edge * 0.7) + 8 * theme.scale;
}

export function buildSequenceScene(model: SequenceModel, layout: LayoutFile): SequenceScene {
  const theme = themeOf(layout.view);
  const k = theme.scale;
  const [gapX, gapY] = layout.view?.spacing ?? [1, 1];
  const measure = (t: string, size = theme.size.edge) => measureText(t, size, false, theme.widthFactor);
  const bubbleSize = bubbleSizeFor(theme);

  // Participant header shapes, reusing the element shapes so every theme applies.
  const headNode = (p: SeqParticipant): DNode => ({ id: p.id, kind: HEAD_KIND[p.kind] ?? 'rectangle', label: p.label, stereotype: p.stereotype, line: p.line });
  const shapes = new Map(model.participants.map((p) => [p.id, nodeShape(headNode(p), theme)]));

  // ---- columns: longest-path over spacing constraints, pinned columns as preferences ----
  const required = (order: string[]) => {
    const index = new Map(order.map((id, i) => [id, i]));
    const need = new Map<string, number>(); // "i|j" -> min distance between centres
    const want = (a: string, b: string, d: number) => {
      let i = index.get(a);
      let j = index.get(b);
      if (i === undefined || j === undefined) return;
      if (i > j) [i, j] = [j, i];
      if (i === j) j = i + 1;
      if (j >= order.length) return;
      const key = `${i}|${j}`;
      need.set(key, Math.max(need.get(key) ?? 0, d));
    };
    for (let i = 0; i + 1 < order.length; i++) {
      want(order[i]!, order[i + 1]!, (shapes.get(order[i]!)!.w + shapes.get(order[i + 1]!)!.w) / 2 + 28 * k * gapX);
    }
    for (const e of model.events) {
      if (e.type === 'message' && e.label !== undefined) {
        const w = measure((e.number ? `${e.number} ` : '') + e.label).width + 28 * k;
        if (e.from === e.to) want(e.from, e.from, w + 30 * k);
        else want(e.from, e.to, w * gapX);
      }
      if (e.type === 'note' && e.over.length) {
        const w = measure(e.text, theme.size.note).width + 30 * k;
        const i = index.get(e.over[0]!)!;
        if (e.side === 'right' && i + 1 < order.length) want(order[i]!, order[i + 1]!, w + 20 * k);
        if (e.side === 'left' && i > 0) want(order[i - 1]!, order[i]!, w + 20 * k);
        if (e.side === 'over' && e.over.length > 1) want(e.over[0]!, e.over[e.over.length - 1]!, w - 40 * k);
      }
    }
    return { index, need };
  };

  const solve = (order: string[], pinned: Record<string, number>) => {
    const { need } = required(order);
    const x: number[] = [];
    order.forEach((id, j) => {
      let v = j === 0 ? shapes.get(id)!.w / 2 + 40 * k : -Infinity;
      for (let i = 0; i < j; i++) {
        const d = need.get(`${i}|${j}`);
        if (d !== undefined) v = Math.max(v, x[i]! + d);
      }
      // A dragged column keeps its place unless it would crowd its neighbours.
      x.push(pinned[id] !== undefined ? Math.max(v, pinned[id]!) : v);
    });
    return Object.fromEntries(order.map((id, j) => [id, x[j]!]));
  };

  const pinned = Object.fromEntries(model.participants.filter((p) => layout.nodes[p.id]).map((p) => [p.id, layout.nodes[p.id]!.x]));
  let order = model.participants.map((p) => p.id);
  let columns = solve(order, {});
  if (Object.keys(pinned).length) {
    // Dragging past a neighbour reorders: sort by where things want to be, then solve again.
    order = [...order].sort((a, b) => (pinned[a] ?? columns[a]!) - (pinned[b] ?? columns[b]!));
    columns = solve(order, pinned);
  }
  const leftEdge = Math.min(...order.map((id) => columns[id]! - shapes.get(id)!.w / 2)) - 30 * k;
  const rightEdge = Math.max(...order.map((id) => columns[id]! + shapes.get(id)!.w / 2)) + 30 * k;

  // ---- rows ----
  const headH = Math.max(...[...shapes.values()].map((s) => s.h));
  const boxTitle = model.boxes.some((b) => b.label) ? 22 * k : 0;
  const top = boxTitle;
  let y = top + headH + 18 * k * gapY;
  const row = (h: number) => (y += h * gapY);

  const activeBars = new Map<string, number[]>(); // participant -> start ys (stack)
  const activations: Box[] = [];
  const created = new Map<string, number>(); // participant -> y of its header
  const destroyed = new Map<string, number>();
  const pendingCreate = new Set<string>();
  const messages: SeqMessage[] = [];
  const notes: SequenceScene['notes'] = [];
  const groups: SequenceScene['groups'] = [];
  const openGroups: { kind: string; label: TextBlock; y0: number; elses: { y: number; label?: TextBlock }[]; x0: number; x1: number; line: number }[] = [];
  const dividers: SequenceScene['dividers'] = [];
  const delays: SequenceScene['delays'] = [];
  const refs: SequenceScene['refs'] = [];
  const destroys: SequenceScene['destroys'] = [];

  const level = (id: string) => activeBars.get(id)?.length ?? 0;
  const barW = 10 * k;
  /** Where a message meets a lifeline, given activation bars and which side it comes from. */
  const attach = (id: string, towardsRight: boolean) => {
    if (id === '[') return leftEdge;
    if (id === ']') return rightEdge;
    const x = columns[id]!;
    const l = level(id);
    if (!l) return x;
    const barCentre = x + (l - 1) * 4 * k;
    return towardsRight ? barCentre + barW / 2 : barCentre - barW / 2;
  };
  const touch = (x0: number, x1: number) => {
    for (const g of openGroups) {
      g.x0 = Math.min(g.x0, x0);
      g.x1 = Math.max(g.x1, x1);
    }
  };

  for (const e of model.events) {
    switch (e.type) {
      case 'message': {
        const bubble = !theme.plantuml && e.number ? bubbleSize(e.number) : 0;
        const text = e.label !== undefined || e.number ? measure((bubble ? [e.label] : [e.number, e.label]).filter(Boolean).join(' ') || ' ') : undefined;
        if (e.from === e.to) {
          const x = attach(e.from, true);
          row((text?.height ?? 0) + 6 * k);
          const m: SeqMessage = { e, x1: x, x2: x + 30 * k, y, self: true };
          if (text) m.label = { text, x: x + 36 * k + (bubble ? bubble - 4 * k : 0), y: y + 9 * k, align: 'start' };
          if (bubble) m.number = { text: e.number!, x: x + 36 * k + bubble / 2 - 4 * k, y: y + 9 * k, r: bubble / 2 - 4 * k };
          messages.push(m);
          touch(x, x + 36 * k + (text?.width ?? 0));
          row(26 * k);
          break;
        }
        const fromX = e.from === '[' ? leftEdge : columns[e.from]!;
        const toX = e.to === ']' ? rightEdge : e.to === '[' ? leftEdge : columns[e.to]!;
        const rightwards = toX > fromX;
        row((text?.height ?? 0) + 6 * k);
        let x2 = attach(e.to, !rightwards);
        if (pendingCreate.has(e.to)) {
          // The created participant's header sits on this message; the arrow ends at its edge.
          pendingCreate.delete(e.to);
          created.set(e.to, y - shapes.get(e.to)!.h / 2);
          x2 = columns[e.to]! + (rightwards ? -1 : 1) * (shapes.get(e.to)!.w / 2);
        }
        const x1 = attach(e.from, rightwards);
        const m: SeqMessage = { e, x1, x2, y, self: false };
        if (text) m.label = { text, x: (x1 + x2) / 2 + bubble / 2, y: y - text.height / 2 - 3 * k, align: 'middle' };
        if (text && bubble) {
          const empty = e.label === undefined || e.label === '';
          // The bubble sits just left of the label text (the label was shifted right by half a bubble).
          const cx = empty ? (x1 + x2) / 2 : (x1 + x2) / 2 - text.width / 2;
          m.number = { text: e.number!, x: cx, y: m.label!.y, r: bubble / 2 - 4 * k };
          if (empty) m.label = undefined;
        }
        messages.push(m);
        touch(Math.min(x1, x2), Math.max(x1, x2));
        row(14 * k + (created.get(e.to) !== undefined && created.get(e.to)! > y - headH ? shapes.get(e.to)!.h / 2 : 0));
        break;
      }
      case 'activate': {
        const stack = activeBars.get(e.participant) ?? [];
        stack.push(y - 2 * k);
        activeBars.set(e.participant, stack);
        break;
      }
      case 'deactivate': {
        const stack = activeBars.get(e.participant);
        const start = stack?.pop();
        if (start !== undefined) {
          const x = columns[e.participant]! + stack!.length * 4 * k;
          activations.push({ x: x - barW / 2, y: start, w: barW, h: Math.max(8 * k, y + 4 * k - start) });
        }
        break;
      }
      case 'create':
        pendingCreate.add(e.participant);
        break;
      case 'destroy': {
        destroyed.set(e.participant, y + 6 * k);
        destroys.push({ x: columns[e.participant]!, y: y + 6 * k });
        for (const start of activeBars.get(e.participant) ?? []) {
          activations.push({ x: columns[e.participant]! - barW / 2, y: start, w: barW, h: y + 6 * k - start });
        }
        activeBars.delete(e.participant);
        row(14 * k);
        break;
      }
      case 'note': {
        const text = measureText(e.text, theme.size.note, false, theme.widthFactor);
        const w = text.width + 24 * k;
        const h = text.height + 14 * k;
        let x0: number;
        if (e.side === 'across') x0 = leftEdge + 10 * k;
        else if (e.side === 'over') {
          const xs = e.over.map((id) => columns[id]!);
          const span = Math.max(...xs) - Math.min(...xs);
          const width = Math.max(w, span + 40 * k);
          x0 = (Math.max(...xs) + Math.min(...xs)) / 2 - width / 2;
          notes.push({ box: { x: x0, y: y + 6 * k, w: width, h }, text, line: e.line });
          touch(x0, x0 + width);
          row(h + 14 * k);
          break;
        } else {
          const x = columns[e.over[0]!]!;
          x0 = e.side === 'right' ? x + 14 * k : x - 14 * k - w;
        }
        const width = e.side === 'across' ? rightEdge - leftEdge - 20 * k : w;
        notes.push({ box: { x: x0, y: y + 6 * k, w: width, h }, text, line: e.line });
        touch(x0, x0 + width);
        row(h + 14 * k);
        break;
      }
      case 'groupStart': {
        const label = measure(e.label ? `[${e.label}]` : '');
        row(4 * k);
        openGroups.push({ kind: e.kind, label, y0: y, elses: [], x0: Infinity, x1: -Infinity, line: e.line });
        row(24 * k);
        break;
      }
      case 'groupElse': {
        const g = openGroups[openGroups.length - 1];
        if (!g) break;
        row(6 * k);
        g.elses.push({ y, label: e.label ? measure(`[${e.label}]`) : undefined });
        row(22 * k);
        break;
      }
      case 'groupEnd': {
        const g = openGroups.pop();
        if (!g) break;
        row(8 * k);
        const depth = openGroups.length;
        const pad = 16 * k - depth * 4 * k;
        const x0 = Number.isFinite(g.x0) ? g.x0 - pad : leftEdge + 10 * k;
        let x1 = Number.isFinite(g.x1) ? g.x1 + pad : rightEdge - 10 * k;
        const tab = measure(g.kind, theme.size.edge).width + g.label.width + 40 * k;
        x1 = Math.max(x1, x0 + tab);
        groups.push({ kind: g.kind, label: g.label, box: { x: x0, y: g.y0, w: x1 - x0, h: y - g.y0 }, elses: g.elses, line: g.line });
        // Parents must enclose their children.
        for (const parent of openGroups) {
          parent.x0 = Math.min(parent.x0, x0 - 4 * k);
          parent.x1 = Math.max(parent.x1, x1 + 4 * k);
        }
        row(10 * k);
        break;
      }
      case 'divider': {
        row(14 * k);
        dividers.push({ y, x0: leftEdge, x1: rightEdge, label: measure(e.label, theme.size.edge) });
        row(18 * k);
        break;
      }
      case 'delay': {
        const y0 = y;
        row(34 * k);
        delays.push({ y0, y1: y, label: e.label ? measure(e.label) : undefined, x: (leftEdge + rightEdge) / 2 });
        break;
      }
      case 'space':
        row(e.size * k);
        break;
      case 'ref': {
        const text = measureText(e.text, theme.size.note, false, theme.widthFactor);
        const xs = e.over.map((id) => columns[id]!);
        const x0 = Math.min(...xs) - 30 * k;
        const x1 = Math.max(Math.max(...xs) + 30 * k, x0 + text.width + 60 * k);
        refs.push({ box: { x: x0, y: y + 8 * k, w: x1 - x0, h: text.height + 30 * k }, text });
        touch(x0, x1);
        row(text.height + 46 * k);
        break;
      }
    }
  }
  row(10 * k);
  const bottom = y;
  // Close bars left open at the end.
  for (const [id, stack] of activeBars) for (const [i, start] of stack.entries()) activations.push({ x: columns[id]! + i * 4 * k - barW / 2, y: start, w: barW, h: bottom - start });

  // ---- headers, footers, lifelines ----
  const heads: SceneNode[] = [];
  const feet: SceneNode[] = [];
  const lifelines: SequenceScene['lifelines'] = [];
  for (const p of model.participants) {
    const shape = shapes.get(p.id)!;
    const x = columns[p.id]!;
    const headTop = created.get(p.id) ?? top + headH - shape.h;
    const node = headNode(p);
    const make = (yTop: number): SceneNode => ({
      node,
      shape,
      box: { x: x - shape.w / 2, y: yTop, w: shape.w, h: shape.h },
      anchor: { ...shape.anchor, cx: x + shape.anchor.dx, cy: yTop + shape.h / 2 + shape.anchor.dy },
      pinned: layout.nodes[p.id] !== undefined,
    });
    heads.push(make(headTop));
    const end = destroyed.get(p.id) ?? bottom;
    if (!model.hideFootbox && !destroyed.has(p.id)) feet.push(make(bottom));
    lifelines.push({ id: p.id, x, y0: headTop + shape.h, y1: end });
  }

  const boxes = model.boxes.map((b) => {
    const xs = b.participants.map((id) => [columns[id]! - shapes.get(id)!.w / 2, columns[id]! + shapes.get(id)!.w / 2]).flat();
    const x0 = Math.min(...xs) - 12 * k;
    const x1 = Math.max(...xs) + 12 * k;
    const y1 = model.hideFootbox ? bottom : bottom + headH;
    return { box: { x: x0, y: 0, w: x1 - x0, h: y1 + 8 * k }, label: measure(b.label, theme.size.container) };
  });

  const all: Box[] = [...heads.map((h) => h.box), ...feet.map((f) => f.box), ...notes.map((n) => n.box), ...groups.map((g) => g.box), ...boxes.map((b) => b.box), ...refs.map((r) => r.box)];
  for (const m of messages) {
    all.push({ x: Math.min(m.x1, m.x2), y: m.y - 2, w: Math.abs(m.x2 - m.x1), h: 4 });
    if (m.label) all.push({ x: m.label.align === 'start' ? m.label.x : m.label.x - m.label.text.width / 2, y: m.label.y - m.label.text.height / 2, w: m.label.text.width, h: m.label.text.height });
  }
  all.push({ x: leftEdge, y: 0, w: rightEdge - leftEdge, h: bottom });
  const x0 = Math.min(...all.map((b) => b.x));
  const y0 = Math.min(...all.map((b) => b.y));
  const x1 = Math.max(...all.map((b) => b.x + b.w));
  const y1 = Math.max(...all.map((b) => b.y + b.h));
  return {
    kind: 'sequence',
    theme,
    heads,
    feet,
    lifelines,
    activations,
    messages,
    notes,
    groups,
    dividers,
    delays,
    refs,
    boxes,
    destroys,
    columns,
    bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
  };
}
