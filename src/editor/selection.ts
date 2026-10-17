import type { Box } from '../scene/containers.ts';

/**
 * Pure selection rules, kept out of Editor.tsx so they can be unit-tested.
 * Graph diagrams select many; ordered ones (sequence, Gantt, timing) select one,
 * because their elements move along a single axis and a group has no meaning.
 */

/** Click on an element. `additive` = Shift / Cmd / Ctrl held: toggle instead of replace. */
export function clickSelect(current: ReadonlySet<string>, id: string, additive: boolean, multi: boolean): Set<string> {
  if (!multi) return new Set([id]);
  if (additive) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  // Clicking an element that is already part of the selection keeps the group, so it can be dragged.
  return current.has(id) ? new Set(current) : new Set([id]);
}

/** Box title click: the box's contents, added to the selection when `additive`. */
export function addAll(current: ReadonlySet<string>, ids: Iterable<string>, additive: boolean): Set<string> {
  const next = additive ? new Set(current) : new Set<string>();
  for (const id of ids) next.add(id);
  return next;
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Marquee: everything fully inside the box; `additive` keeps what was selected before. */
export function marqueeSelect(
  current: ReadonlySet<string>,
  candidates: { id: string; box: Box }[],
  box: Box,
  additive: boolean,
): Set<string> {
  const next = additive ? new Set(current) : new Set<string>();
  for (const c of candidates) if (contains(box, c.box)) next.add(c.id);
  return next;
}

/** Rectangle spanned by two corner points. */
export function boxFrom(a: [number, number], b: [number, number]): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

/** Folder → basenames, for a file picker that doesn't show full paths. Folders and files keep server order. */
export function groupByFolder(files: string[]): { folder: string; files: { path: string; name: string }[] }[] {
  const groups = new Map<string, { path: string; name: string }[]>();
  for (const path of files) {
    const cut = path.lastIndexOf('/');
    const folder = cut < 0 ? '.' : path.slice(0, cut);
    const list = groups.get(folder) ?? [];
    list.push({ path, name: path.slice(cut + 1) });
    groups.set(folder, list);
  }
  return [...groups].map(([folder, list]) => ({ folder, files: list }));
}

export type FileFormat = 'plantuml' | 'mermaid' | 'drawio';

/** Short badge text per format, in the picker and on its key. */
export const FORMAT_BADGE: Record<FileFormat, string> = { plantuml: 'PUML', mermaid: 'MMD', drawio: 'DRAWIO' };

/** The format a file name implies; a sniffed `.xml` is draw.io (the server only lists draw.io XML). */
export function formatOf(path: string): FileFormat {
  if (/\.(drawio|drawio\.xml|xml)$/i.test(path)) return 'drawio';
  if (/\.(mmd|mermaid)$/i.test(path)) return 'mermaid';
  return 'plantuml';
}

/**
 * Picker filter: every whitespace-separated word must occur in the path or
 * the format's names (`mmd`, `mermaid`, `drawio`, `draw.io`, `puml`,
 * `plantuml`), case-insensitive. An empty query keeps everything.
 */
export function filterFiles(files: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return files;
  const names: Record<FileFormat, string> = { plantuml: 'puml plantuml', mermaid: 'mmd mermaid', drawio: 'drawio draw.io' };
  return files.filter((f) => {
    const hay = `${f.toLowerCase()} ${names[formatOf(f)]}`;
    return words.every((w) => hay.includes(w));
  });
}
