import { DIAGRAM_FILE } from '../paths.ts';

/** File types the Open dialog offers: every diagram source plus the layout sidecar. */
export const OPEN_ACCEPT = '.puml,.plantuml,.pu,.mmd,.mermaid,.drawio,.xml,.json';

/** Folder the editor files opened from disk are listed under. */
export const OPENED_DIR = 'opened';

const SIDECAR = /\.layout\.json$/i;

export type FileKind = 'diagram' | 'layout' | 'other';

/** What a file name is: a diagram source, a `x.layout.json` sidecar, or something to refuse. */
export function kindOf(name: string): FileKind {
  if (SIDECAR.test(name)) return 'layout';
  return DIAGRAM_FILE.test(name) ? 'diagram' : 'other';
}

/** A plain `.xml` only counts as a diagram when it holds draw.io XML (the server sniffs the same way). */
export function looksLikeDiagram(name: string, text: string): boolean {
  if (kindOf(name) !== 'diagram') return false;
  if (!/\.xml$/i.test(name) || /\.drawio\.xml$/i.test(name)) return true;
  return /<(mxfile|mxGraphModel)\b/.test(text.slice(0, 2048));
}

/** `dir/x.puml` → `x`; the stem the sidecar `x.layout.json` is paired by. */
export function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop()!;
  return base.replace(SIDECAR, '').replace(DIAGRAM_FILE, '');
}

/** Key a disk file is listed under: `opened/x.puml`. */
export function openedKey(name: string): string {
  return `${OPENED_DIR}/${name.split(/[\\/]/).pop()!}`;
}

export interface Paired<T> {
  /** Each diagram with the sidecar sharing its stem, if one was given. */
  pairs: { diagram: T; layout?: T }[];
  /** Sidecars with no diagram among the files (the editor offers them to the open diagram). */
  strayLayouts: T[];
  /** Neither a diagram nor a sidecar. */
  rejected: T[];
}

/**
 * Pairs dropped or picked files: `x.puml` + `x.layout.json` load together.
 * A sidecar goes to every diagram of its stem (`x.puml` and `x.mmd` share one,
 * as on disk). Order of the diagrams is kept.
 */
export function pairFiles<T extends { name: string }>(files: T[]): Paired<T> {
  const layouts = new Map<string, T>();
  const diagrams: T[] = [];
  const rejected: T[] = [];
  for (const f of files) {
    const kind = kindOf(f.name);
    if (kind === 'layout') layouts.set(stemOf(f.name).toLowerCase(), f);
    else if (kind === 'diagram') diagrams.push(f);
    else rejected.push(f);
  }
  const used = new Set<string>();
  const pairs = diagrams.map((diagram) => {
    const key = stemOf(diagram.name).toLowerCase();
    const layout = layouts.get(key);
    if (layout) used.add(key);
    return { diagram, layout };
  });
  const strayLayouts = [...layouts].filter(([k]) => !used.has(k)).map(([, f]) => f);
  return { pairs, strayLayouts, rejected };
}

/** Sorts a listing so `opened/` stays last: the server's (or the samples') order is kept. */
export function withOpened(base: string[], opened: Iterable<string>): string[] {
  const set = new Set(base);
  return [...base, ...[...opened].filter((o) => !set.has(o)).sort()];
}
