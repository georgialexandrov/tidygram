import type { DEdge, DNode, ParseWarning } from './types.ts';
import type { ParseResult } from './parse.ts';
import { parseNameSpec, unescape, type Line } from './puml-util.ts';

/**
 * `@startchen`: Chen-notation ER. Entities are rectangles, relationships
 * diamonds, attributes ellipses hanging off their owner. `<<weak>>`,
 * `<<identifying>>` and `<<multi>>` draw double outlines, `<<key>>` underlines,
 * `<<derived>>` dashes. `A -N- B` labels the line with the cardinality,
 * `A =N= B` is total participation (double line). Subclasses:
 * `PARENT =>= d { A, B }` (a d/U circle) and `CHILD ->- PARENT`.
 *
 * Attribute ids are owner-qualified (`DIRECTOR.Name.Fname`), so two entities
 * can both have a `Name`.
 */

const LINK = String.raw`([-=])(?:([^-=(\s<>^][^-=\s]*)|\(([^)]*)\)|([<>^]))?([-=])`;
const RELATION_RE = new RegExp(String.raw`^([\p{L}\p{N}_.]+)\s*${LINK}\s*([\p{L}\p{N}_.]+)$`, 'u');
const SUBCLASS_RE = new RegExp(String.raw`^([\p{L}\p{N}_.]+)\s*${LINK}\s*(d|U)\s*\{\s*(.*?)\s*\}$`, 'u');

export function parseChen(lines: Line[]): ParseResult {
  const nodes = new Map<string, DNode>();
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  const counts = new Map<string, number>();
  /** Owners of the attribute block being read: entity/relationship, then composite attributes. */
  const stack: string[] = [];
  let direction: 'TB' | 'LR' = 'TB';
  let subclassCount = 0;

  const addEdge = (from: string, to: string, op: string, line: number, extra: Partial<DEdge> = {}) => {
    const base = `${from}${op}${to}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    edges.push({ id: n === 1 ? base : `${base}#${n}`, from, to, kind: 'association', dashed: false, head: 'none', tail: 'none', hidden: false, line, ...extra });
  };

  const ensure = (id: string, line: number) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'rectangle', label: id, line });
    return nodes.get(id)!;
  };

  const flags = (node: DNode, stereotype: string | undefined) => {
    for (const s of (stereotype ?? '').split(/\s*,\s*/).filter(Boolean)) {
      const t = s.toLowerCase();
      if (t === 'weak' || t === 'identifying' || t === 'multi') node.double = true;
      else if (t === 'key') node.key = true;
      else if (t === 'derived') node.derived = true;
      else node.stereotype = node.stereotype ? `${node.stereotype}, ${s}` : s;
    }
  };

  for (const { no, raw, text } of lines) {
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;
    if (/^(skinparam|title|hide|show|scale|caption|header|footer)\b/i.test(text)) continue;
    if (/^left\s+to\s+right\s+direction$/i.test(text)) {
      direction = 'LR';
      continue;
    }
    if (/^top\s+to\s+bottom\s+direction$/i.test(text)) {
      direction = 'TB';
      continue;
    }

    if (text === '}') {
      if (!stack.length) warnings.push({ line: no, text: raw, message: 'Unmatched }' });
      stack.pop();
      continue;
    }

    // Inside a block: attributes, possibly composite (`Name {`).
    if (stack.length) {
      const m = /^(.+?)\s*(\{)?\s*(\})?$/.exec(text)!;
      const owner = stack[stack.length - 1]!;
      const stereo = /<<\s*([^>]*?)\s*>>/g;
      const stereotypes = [...m[1]!.matchAll(stereo)].map((s) => s[1]!).join(',');
      const label = unescape(m[1]!.replace(stereo, '').trim());
      const name = label.split(':')[0]!.trim();
      const id = `${owner}.${name}`;
      const attr: DNode = { id, kind: 'attribute', label, line: no };
      flags(attr, stereotypes);
      nodes.set(id, attr);
      addEdge(owner, id, '--', no);
      if (m[2] && !m[3]) stack.push(id);
      continue;
    }

    const decl = /^(entity|relationship)\s+(.+?)\s*(\{)?\s*(\})?$/i.exec(text);
    if (decl) {
      const spec = parseNameSpec(decl[2]!);
      if (!spec) continue;
      const node = ensure(spec.id, no);
      node.kind = decl[1]!.toLowerCase() === 'entity' ? 'rectangle' : 'relationship';
      node.label = spec.label;
      node.line = no;
      flags(node, spec.stereotype);
      if (decl[3] && !decl[4]) stack.push(spec.id);
      continue;
    }

    const sub = SUBCLASS_RE.exec(text);
    if (sub) {
      const [, parent, l, , , mark, r, kind, list] = sub;
      ensure(parent!, no);
      subclassCount++;
      const circle = `${parent}/${kind}${subclassCount === 1 ? '' : subclassCount}`;
      nodes.set(circle, { id: circle, kind: 'circle', label: kind!, line: no });
      addEdge(parent!, circle, `${l}${r}`, no, { double: l === '=' });
      for (const child of list!.split(/\s*,\s*/).filter(Boolean)) {
        ensure(child, no);
        addEdge(circle, child, `-${mark ?? ''}-`, no, mark === '>' || mark === '<' ? { head: 'arrow' } : {});
      }
      continue;
    }

    const rel = RELATION_RE.exec(text);
    if (rel) {
      const [, from, l, card, range, mark, r, to] = rel;
      ensure(from!, no);
      ensure(to!, no);
      const cardinality = card ?? (range !== undefined ? `(${range})` : undefined);
      const op = `${l}${cardinality ?? mark ?? ''}${r}`;
      const extra: Partial<DEdge> = { double: l === '=' };
      if (cardinality) extra.label = cardinality;
      // `CHILD ->- PARENT`: subset; the mark points at the superclass.
      if (mark === '>') extra.head = 'arrow';
      if (mark === '<') extra.tail = 'arrow';
      if (mark === '^') extra.head = 'triangle';
      addEdge(from!, to!, op, no, extra);
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }
  if (stack.length) warnings.push({ line: lines.at(-1)?.no ?? 1, text: '', message: `Unclosed block: ${stack.at(-1)}` });

  return { diagram: { family: 'chen', direction, nodes: [...nodes.values()], containers: [], edges }, warnings };
}
