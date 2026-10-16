/** Helpers shared by the PlantUML parsers. */

export interface Line {
  no: number;
  raw: string;
  text: string;
}

export function unescape(label: string): string {
  return label
    .replace(/\\n/g, '\n')
    .replace(/<<\s*([^>]*?)\s*>>/g, '«$1»')
    .trim();
}

export function stripDecorations(text: string): { rest: string; stereotype?: string } {
  let stereotype: string | undefined;
  const rest = text
    .replace(/<<\s*([^>]*?)\s*>>/g, (_m, s: string) => {
      stereotype = stereotype ? `${stereotype}, ${s}` : s;
      return ' ';
    })
    .replace(/\s#[\w#;:.]+/g, ' ')
    .replace(/\s##(\[[^\]]*\])?\w*/g, ' ')
    .replace(/\$\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { rest, stereotype };
}

export type Shape = 'actor' | 'usecase' | 'component' | 'interface' | 'initial';

export function parseAtom(text: string): { value: string; shape?: Shape; quoted: boolean } {
  const t = text.trim();
  if (t === '[*]') return { value: '[*]', shape: 'initial', quoted: false };
  if (t.startsWith('"') && t.endsWith('"')) return { value: t.slice(1, -1), quoted: true };
  if (t.startsWith('()')) return { value: parseAtom(t.slice(2)).value, shape: 'interface', quoted: true };
  if (t.startsWith('(') && t.endsWith(')')) return { value: t.slice(1, -1), shape: 'usecase', quoted: true };
  if (t.startsWith('[') && t.endsWith(']')) return { value: t.slice(1, -1), shape: 'component', quoted: true };
  if (t.startsWith(':') && t.endsWith(':') && t.length > 1) return { value: t.slice(1, -1), shape: 'actor', quoted: true };
  return { value: t, quoted: false };
}

export interface NameSpec {
  id: string;
  label: string;
  stereotype?: string;
  shape?: Shape;
}

/** `"Label" as Alias`, `Alias as "Label"`, `(Label) as A`, `[Label] as A`, `:Label:`, `Name`. */
export function parseNameSpec(text: string): NameSpec | undefined {
  const { rest, stereotype } = stripDecorations(text);
  if (!rest) return undefined;
  const asMatch = /^(.*?)\s+as\s+(.*)$/.exec(rest);
  if (asMatch) {
    const left = parseAtom(asMatch[1]!);
    const right = parseAtom(asMatch[2]!);
    if (!left.quoted && right.quoted) return { id: left.value, label: unescape(right.value), stereotype, shape: right.shape };
    return { id: right.value, label: unescape(left.value), stereotype, shape: left.shape };
  }
  const atom = parseAtom(rest);
  return { id: atom.value, label: unescape(atom.value), stereotype, shape: atom.shape };
}

/** Splits macro arguments: commas outside quotes and parentheses. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export const unquote = (s: string | undefined) => (s ?? '').trim().replace(/^"(.*)"$/, '$1');

