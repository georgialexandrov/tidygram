import type { DEdge, DNode, ParseWarning } from './types.ts';
import type { ParseResult } from './parse.ts';
import type { Line } from './puml-util.ts';

/**
 * `@startjson` / `@startyaml`: a data tree drawn as tables. Every object or
 * array is a box of rows; a scalar value sits in its row, a nested object or
 * array gets its own box with a line labelled by the key. Ids are paths from
 * the root (`$`, `$.address`, `$.items[0]`), so a layout survives edits to
 * values and survives keys being added elsewhere.
 */

type Value =
  | { type: 'object'; entries: { key: string; value: Value; line: number }[]; line: number }
  | { type: 'array'; items: Value[]; line: number }
  | { type: 'scalar'; text: string; line: number };

export function parseData(lines: Line[], format: 'json' | 'yaml'): ParseResult {
  const warnings: ParseWarning[] = [];
  const body = dataLines(lines);
  let root: Value | undefined;
  try {
    root = format === 'json' ? new JsonReader(body).document() : new YamlReader(body).document();
  } catch (err) {
    const e = err as Error & { line?: number };
    warnings.push({ line: e.line ?? body[0]?.no ?? 1, text: '', message: `${format.toUpperCase()} not understood: ${e.message}` });
  }
  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  if (root) emit(root, '$', nodes, edges);
  return { diagram: { family: 'json', direction: 'LR', nodes, containers: [], edges }, warnings };
}

/** The document between the tags, minus PlantUML's own directives (`#highlight`, `<style>`, `!theme`). */
function dataLines(lines: Line[]): Line[] {
  const out: Line[] = [];
  let style = false;
  for (const l of lines) {
    if (/^@(start|end)\w+/.test(l.text)) continue;
    if (/^<style>/.test(l.text)) style = true;
    if (style) {
      if (/<\/style>/.test(l.text)) style = false;
      continue;
    }
    if (/^#highlight\b/.test(l.text) || /^!/.test(l.text)) continue;
    out.push(l);
  }
  return out;
}

const shortScalar = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

function emit(value: Value, id: string, nodes: DNode[], edges: DEdge[]): void {
  const rows: string[] = [];
  const children: [key: string, childId: string, child: Value][] = [];
  if (value.type === 'scalar') rows.push(shortScalar(value.text));
  if (value.type === 'object') {
    for (const { key, value: v } of value.entries) {
      if (v.type === 'scalar') rows.push(`${key}: ${shortScalar(v.text)}`);
      else {
        rows.push(`${key}: ${v.type === 'object' ? '{…}' : '[…]'}`);
        children.push([key, `${id}.${key}`, v]);
      }
    }
    if (!value.entries.length) rows.push('{}');
  }
  if (value.type === 'array') {
    value.items.forEach((v, i) => {
      if (v.type === 'scalar') rows.push(shortScalar(v.text));
      else {
        rows.push(`[${i}]: ${v.type === 'object' ? '{…}' : '[…]'}`);
        children.push([`[${i}]`, `${id}[${i}]`, v]);
      }
    });
    if (!value.items.length) rows.push('[]');
  }
  nodes.push({ id, kind: 'class', classKind: 'json', label: '', compartments: [rows], line: value.line });
  for (const [key, childId, child] of children) {
    edges.push({ id: `${id}-->${childId}`, from: id, to: childId, kind: 'association', dashed: false, head: 'arrow', tail: 'none', label: key, hidden: false, line: child.line });
    emit(child, childId, nodes, edges);
  }
}

class ReadError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

// ---- JSON ----------------------------------------------------------------------------------------

/** A small JSON reader that remembers which source line each value starts on. */
class JsonReader {
  private text: string;
  private pos = 0;
  /** Character offset where each body line starts, and that line's number in the file. */
  private starts: { at: number; no: number }[] = [];

  constructor(lines: Line[]) {
    let at = 0;
    for (const l of lines) {
      this.starts.push({ at, no: l.no });
      at += l.raw.length + 1;
    }
    this.text = lines.map((l) => l.raw).join('\n');
  }

  document(): Value {
    const v = this.value();
    this.space();
    if (this.pos < this.text.length) throw this.error('unexpected text after the document');
    return v;
  }

  private lineAt(pos = this.pos): number {
    let no = this.starts[0]?.no ?? 1;
    for (const s of this.starts) if (s.at <= pos) no = s.no;
    return no;
  }

  private error(message: string) {
    return new ReadError(message, this.lineAt());
  }

  private space() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }

  private value(): Value {
    this.space();
    const line = this.lineAt();
    const ch = this.text[this.pos];
    if (ch === '{') {
      this.pos++;
      const entries: { key: string; value: Value; line: number }[] = [];
      this.space();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return { type: 'object', entries, line };
      }
      for (;;) {
        this.space();
        const keyLine = this.lineAt();
        if (this.text[this.pos] !== '"') throw this.error('expected a quoted key');
        const key = this.string();
        this.space();
        if (this.text[this.pos] !== ':') throw this.error('expected :');
        this.pos++;
        entries.push({ key, value: this.value(), line: keyLine });
        this.space();
        const next = this.text[this.pos++];
        if (next === '}') return { type: 'object', entries, line };
        if (next !== ',') throw this.error('expected , or }');
      }
    }
    if (ch === '[') {
      this.pos++;
      const items: Value[] = [];
      this.space();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return { type: 'array', items, line };
      }
      for (;;) {
        items.push(this.value());
        this.space();
        const next = this.text[this.pos++];
        if (next === ']') return { type: 'array', items, line };
        if (next !== ',') throw this.error('expected , or ]');
      }
    }
    if (ch === '"') return { type: 'scalar', text: this.string(), line };
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(this.text.slice(this.pos));
    if (!m) throw this.error('expected a value');
    this.pos += m[0].length;
    return { type: 'scalar', text: m[0], line };
  }

  private string(): string {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(this.text.slice(this.pos));
    if (!m) throw this.error('unterminated string');
    this.pos += m[0].length;
    try {
      return JSON.parse(m[0]) as string;
    } catch {
      return m[1]!;
    }
  }
}

// ---- YAML ----------------------------------------------------------------------------------------

interface YLine {
  indent: number;
  text: string;
  no: number;
}

/**
 * The block subset of YAML that config files use: mappings, sequences,
 * `- key: value` items, flow `[a, b]` / `{a: 1}`, block scalars `|` and `>`,
 * comments. Anchors and tags are read as plain text.
 */
class YamlReader {
  private lines: YLine[];
  private i = 0;

  constructor(lines: Line[]) {
    this.lines = lines
      .map((l) => ({ indent: l.raw.length - l.raw.trimStart().length, text: stripComment(l.raw.trim()), no: l.no }))
      .filter((l) => l.text && l.text !== '---' && l.text !== '...');
  }

  document(): Value {
    if (!this.lines.length) return { type: 'object', entries: [], line: 1 };
    const v = this.block(this.lines[0]!.indent);
    if (this.i < this.lines.length) throw new ReadError('unexpected indentation', this.lines[this.i]!.no);
    return v;
  }

  private block(indent: number): Value {
    const l = this.lines[this.i]!;
    if (isDash(l.text)) return this.sequence(indent);
    if (keyOf(l.text)) return this.mapping(indent);
    this.i++;
    return flow(l.text, l.no);
  }

  private sequence(indent: number): Value {
    const line = this.lines[this.i]!.no;
    const items: Value[] = [];
    while (this.i < this.lines.length && this.lines[this.i]!.indent === indent && isDash(this.lines[this.i]!.text)) {
      const l = this.lines[this.i]!;
      const rest = l.text.slice(1).trim();
      if (!rest) {
        this.i++;
        items.push(this.nested(indent, l.no));
      } else if (keyOf(rest) || isDash(rest)) {
        // `- key: value`: the item is a mapping (or sequence) whose first line starts after the dash.
        const offset = l.text.length - rest.length;
        this.lines[this.i] = { indent: indent + offset, text: rest, no: l.no };
        items.push(this.block(indent + offset));
      } else {
        this.i++;
        items.push(flow(rest, l.no));
      }
    }
    return { type: 'array', items, line };
  }

  private mapping(indent: number): Value {
    const line = this.lines[this.i]!.no;
    const entries: { key: string; value: Value; line: number }[] = [];
    while (this.i < this.lines.length && this.lines[this.i]!.indent === indent && !isDash(this.lines[this.i]!.text)) {
      const l = this.lines[this.i]!;
      const kv = keyOf(l.text);
      if (!kv) throw new ReadError('expected key: value', l.no);
      this.i++;
      const [key, rest] = kv;
      let value: Value;
      if (rest === '' || rest === undefined) {
        // A sequence may sit at the key's own indentation.
        const next = this.lines[this.i];
        value = next && next.indent === indent && isDash(next.text) ? this.sequence(indent) : this.nested(indent, l.no);
      } else if (/^[|>][-+]?$/.test(rest)) {
        const body: string[] = [];
        while (this.i < this.lines.length && this.lines[this.i]!.indent > indent) body.push(this.lines[this.i++]!.text);
        value = { type: 'scalar', text: rest.startsWith('|') ? body.join(' ⏎ ') : body.join(' '), line: l.no };
      } else value = flow(rest, l.no);
      entries.push({ key, value, line: l.no });
    }
    return { type: 'object', entries, line };
  }

  /** The value of an empty key or bare dash: a deeper block, or null. */
  private nested(indent: number, no: number): Value {
    const next = this.lines[this.i];
    if (next && next.indent > indent) return this.block(next.indent);
    return { type: 'scalar', text: 'null', line: no };
  }
}

const isDash = (text: string) => text === '-' || text.startsWith('- ');

function keyOf(text: string): [string, string] | undefined {
  const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'[{#][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
  if (!m) return undefined;
  return [unquoteYaml(m[1]!), (m[2] ?? '').trim()];
}

function stripComment(text: string): string {
  if (text.startsWith('#')) return '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && /\s/.test(text[i - 1] ?? '')) return text.slice(0, i).trim();
  }
  return text;
}

const unquoteYaml = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** A scalar, or a flow collection `[a, b]` / `{a: 1, b: [2]}`. */
function flow(text: string, line: number): Value {
  const t = text.trim();
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    const parts = splitFlow(t.slice(1, -1));
    if (t.startsWith('[')) return { type: 'array', items: parts.map((p) => flow(p, line)), line };
    return {
      type: 'object',
      entries: parts.map((p) => {
        const kv = keyOf(p) ?? [p, ''];
        return { key: kv[0], value: flow(kv[1] || 'null', line), line };
      }),
      line,
    };
  }
  return { type: 'scalar', text: unquoteYaml(t), line };
}

function splitFlow(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
