/**
 * Small tolerant XML reader for draw.io files. The browser has DOMParser but
 * Node (CLI, Vitest) doesn't, and one code path is worth more than a full
 * parser: draw.io writes plain, well-formed XML. Handles elements,
 * attributes (either quote), text, comments, CDATA, `<?...?>` and `<!...>`
 * declarations, and the predefined and numeric entities. Never throws:
 * unclosed elements close at the end, a stray close tag closes back to its
 * match or is ignored.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text content directly inside this element. */
  text: string;
  /** 1-based line of the opening `<`. */
  line: number;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes `&lt;` `&amp;` `&#10;` `&#xa;` ...; unknown entities are left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

export function parseXml(source: string): XmlElement {
  const doc: XmlElement = { name: '#document', attrs: {}, children: [], text: '', line: 1 };
  const stack: XmlElement[] = [doc];
  let i = 0;
  let line = 1;
  /** Advances to `to`, counting newlines on the way. */
  const advance = (to: number) => {
    for (let j = i; j < to; j++) if (source.charCodeAt(j) === 10) line++;
    i = to;
  };
  const skipPast = (marker: string) => {
    const end = source.indexOf(marker, i);
    advance(end < 0 ? source.length : end + marker.length);
    return end;
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > i) stack[stack.length - 1]!.text += decodeEntities(source.slice(i, textEnd));
    advance(textEnd);
    if (lt < 0) break;

    if (source.startsWith('<!--', i)) {
      skipPast('-->');
    } else if (source.startsWith('<![CDATA[', i)) {
      const start = i + 9;
      const end = skipPast(']]>');
      stack[stack.length - 1]!.text += source.slice(start, end < 0 ? source.length : end);
    } else if (source[i + 1] === '?' || source[i + 1] === '!') {
      skipPast('>');
    } else if (source[i + 1] === '/') {
      const end = source.indexOf('>', i);
      const name = source.slice(i + 2, end < 0 ? source.length : end).trim();
      advance(end < 0 ? source.length : end + 1);
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else {
      const startLine = line;
      // Scan the tag, skipping quoted attribute values (they may contain '>').
      let j = i + 1;
      let quote = '';
      for (; j < source.length; j++) {
        const ch = source[j]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      const body = source.slice(i + 1, j);
      advance(Math.min(j + 1, source.length));
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) continue;
      const el: XmlElement = { name: nameMatch[0], attrs: {}, children: [], text: '', line: startLine };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(inner.slice(nameMatch[0].length)))) el.attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
      stack[stack.length - 1]!.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  return doc;
}

/** First descendant (depth-first, including `el` itself) with this name. */
export function findElement(el: XmlElement, name: string): XmlElement | undefined {
  if (el.name === name) return el;
  for (const child of el.children) {
    const found = findElement(child, name);
    if (found) return found;
  }
  return undefined;
}
