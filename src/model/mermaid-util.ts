import type { ArrowHead, DEdge, EdgeKind } from './types.ts';
import { HEAD_TOKENS } from './parse.ts';
import type { Line } from './puml-util.ts';

/** Helpers shared by the Mermaid readers. */

/**
 * Splits the source into lines, dropping what never carries diagram content:
 * `%%` comments, `%%{init}%%` directives and a leading `---` front-matter block.
 * Line numbers stay those of the file, so warnings and the source panel agree.
 */
export function mermaidLines(source: string): Line[] {
  const raw = source.split(/\r?\n/);
  const lines: Line[] = [];
  let i = 0;
  while (i < raw.length && !raw[i]!.trim()) i++;
  if (raw[i]?.trim() === '---') {
    const close = raw.findIndex((l, j) => j > i && l.trim() === '---');
    if (close !== -1) i = close + 1;
  }
  for (; i < raw.length; i++) {
    const text = raw[i]!.trim();
    if (!text || text.startsWith('%%')) continue;
    lines.push({ no: i + 1, raw: raw[i]!, text });
  }
  return lines;
}

/**
 * Display text from a Mermaid label: drops surrounding quotes and markdown
 * backticks, turns `<br>` into a line break, decodes `#quot;`-style entity
 * codes and strips other HTML and `**bold**` markers we don't style.
 */
export function mmdText(text: string): string {
  let t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim();
  if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) t = t.slice(1, -1).trim();
  return t
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\\n/g, '\n')
    .replace(/#(\w+);/g, (m, code: string) => ENTITIES[code] ?? (/^\d+$/.test(code) ? String.fromCodePoint(Number(code)) : m))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/**
 * A flowchart node label whose last `<br>` lines are `<small>…</small>`:
 * extra lines under the name (our conversion folds C4 descriptions in that
 * way, and Mermaid draws them smaller). A first small line in brackets is
 * the C4 technology.
 */
export function mmdLabelParts(text: string): { label: string; description?: string[]; technology?: string } {
  let t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).trim();
  const parts = t.split(/<br\s*\/?>/i);
  const under: string[] = [];
  while (parts.length > 1 && /^\s*<small>(?:(?!<\/?small>)[\s\S])*<\/small>\s*$/i.test(parts[parts.length - 1]!)) under.unshift(mmdText(parts.pop()!));
  const out: { label: string; description?: string[]; technology?: string } = { label: mmdText(parts.join('<br>')) };
  const tech = /^\[(.*)\]$/.exec(under[0] ?? '');
  if (tech) {
    out.technology = tech[1]!;
    under.shift();
  }
  if (under.length) out.description = under;
  return out;
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", semi: ';', colon: ':', hash: '#' };

export interface EdgeStyle {
  dashed: boolean;
  head: ArrowHead;
  tail: ArrowHead;
  hidden?: boolean;
}

/**
 * Builds edges the way the PlantUML reader does, so ids look the same in
 * layout.json whichever format the diagram is in: `A-->B`, `B--|>A`,
 * `A||--o{B`, `#2` for repeats; a one-ended arrow written backwards
 * (`A <|-- B`) is stored forwards with `reversed`.
 */
export function edgeBuilder() {
  const edges: DEdge[] = [];
  const counts = new Map<string, number>();
  const add = (from: string, to: string, style: EdgeStyle, line: number, extra: { label?: string; fromLabel?: string; toLabel?: string; note?: boolean } = {}): DEdge => {
    let [src, dst, head, tail, fromLabel, toLabel] = [from, to, style.head, style.tail, extra.fromLabel, extra.toLabel];
    let reversed = false;
    if (tail !== 'none' && head === 'none') {
      [src, dst, head, tail, fromLabel, toLabel] = [to, from, tail, head, toLabel, fromLabel];
      reversed = true;
    }
    const heads = [head, tail];
    const kind: EdgeKind = extra.note
      ? 'noteLink'
      : heads.includes('triangle')
        ? style.dashed
          ? 'realization'
          : 'generalization'
        : heads.includes('diamondFilled')
          ? 'composition'
          : heads.includes('diamond')
            ? 'aggregation'
            : style.dashed
              ? 'dependency'
              : 'association';
    const base = `${src}${HEAD_TOKENS[tail][0]}${style.dashed || extra.note ? '..' : '--'}${HEAD_TOKENS[head][1]}${dst}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const edge: DEdge = { id: n === 1 ? base : `${base}#${n}`, from: src, to: dst, kind, dashed: style.dashed || !!extra.note, head, tail, hidden: !!style.hidden, line };
    if (reversed) edge.reversed = true;
    if (extra.label) edge.label = extra.label;
    if (fromLabel) edge.fromLabel = fromLabel;
    if (toLabel) edge.toLabel = toLabel;
    edges.push(edge);
    return edge;
  };
  return { edges, add };
}

/** Splits `a; b` statements on semicolons outside quotes and brackets (`#quot;` entity codes survive). */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && '([{'.includes(ch)) depth++;
    else if (!quoted && ')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ';' && !quoted && depth === 0 && !/#\w+$/.test(current)) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
