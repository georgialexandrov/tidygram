import { OPENED_DIR, openedKey } from './openFiles.ts';

/**
 * Where the editor's files live. Three homes, picked per file:
 *  - opened from disk (`opened/…`): in memory, plus an optional File System Access handle for the sidecar;
 *  - bundled samples (static demo, no dev server): read-only source, layout kept in memory and localStorage;
 *  - the Vite plugin's folder (dev): `/api/*`.
 */

declare const __DEMO__: boolean;
/** True in the static build (`pnpm build:demo`): no server plugin, samples compiled in. */
export const DEMO: boolean = typeof __DEMO__ !== 'undefined' && __DEMO__;

/** The slice of the File System Access API used here (Chrome; absent elsewhere). */
export interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(d: { mode: 'readwrite' }): Promise<string>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<string>;
}
type PickerWindow = {
  showOpenFilePicker?: (o: { multiple: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>;
};
const picker = () => window as unknown as PickerWindow;
export const canPickHandles = () => typeof picker().showOpenFilePicker === 'function';

interface Entry {
  source: string;
  layout: string | null;
  layoutHandle?: FileHandle;
}
const memory = new Map<string, Entry>();

const LS = 'tidygram:layout:';
function lsGet(file: string): string | null {
  try {
    return localStorage.getItem(LS + file);
  } catch {
    return null;
  }
}
function lsSet(file: string, body: string) {
  try {
    localStorage.setItem(LS + file, body);
  } catch {
    /* private window or quota: the layout stays in memory */
  }
}

/** True for files that have no server behind them: opened from disk, or a bundled sample. */
export const isLocal = (file: string | null): boolean => !!file && (DEMO || memory.has(file));
export const isOpened = (file: string | null): boolean => !!file && memory.has(file);
export const hasLayoutHandle = (file: string | null): boolean => !!file && !!memory.get(file)?.layoutHandle;
export const openedFiles = (): string[] => [...memory.keys()];

/** Registers a file read from disk; returns its key in the picker. */
export function addOpened(name: string, source: string, layout: string | null, layoutHandle?: FileHandle): string {
  const key = openedKey(name);
  memory.set(key, { source, layout, layoutHandle });
  return key;
}

export async function listFiles(): Promise<string[]> {
  if (DEMO) return (await import('./samples.ts')).sampleList();
  const j = (await (await fetch('/api/files')).json()) as { files: string[] };
  return j.files;
}

export async function readDoc(file: string): Promise<{ source: string; layout: string | null }> {
  const local = memory.get(file);
  if (local) return { source: local.source, layout: local.layout };
  if (DEMO) {
    const source = await (await import('./samples.ts')).sampleSource(file);
    if (source === undefined) throw new Error(`unknown sample ${file}`);
    return { source, layout: lsGet(file) };
  }
  const res = await fetch(`/api/doc?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
  return (await res.json()) as { source: string; layout: string | null };
}

/** Saves a sidecar to wherever the file lives; true on success. */
export async function writeLayout(file: string, body: string): Promise<boolean> {
  const local = memory.get(file);
  if (local) {
    local.layout = body;
    if (local.layoutHandle) {
      try {
        const w = await local.layoutHandle.createWritable();
        await w.write(body);
        await w.close();
      } catch {
        return false;
      }
    }
    return true;
  }
  if (DEMO) {
    lsSet(file, body);
    return true;
  }
  const res = await fetch(`/api/layout?file=${encodeURIComponent(file)}`, { method: 'PUT', body });
  return res.ok;
}

const TYPES = [
  { description: 'Diagrams and layouts', accept: { 'text/plain': ['.puml', '.plantuml', '.pu', '.mmd', '.mermaid', '.drawio', '.xml', '.json'] } },
];

/** Chrome's open dialog with handles (so the sidecar can be written back); undefined if cancelled. */
export async function pickWithHandles(): Promise<{ file: File; handle: FileHandle }[] | undefined> {
  try {
    const handles = await picker().showOpenFilePicker!({ multiple: true, types: TYPES });
    return await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch {
    return undefined; // AbortError: the user closed the dialog
  }
}

/** Asks for write access to a handle (needs the click that is still in flight). */
export async function ensureWritable(handle: FileHandle): Promise<boolean> {
  try {
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Gives an opened file a sidecar handle through Save As; false when unsupported or cancelled. */
export async function attachLayoutHandle(file: string, suggestedName: string): Promise<boolean> {
  const local = memory.get(file);
  if (!local || !picker().showSaveFilePicker) return false;
  try {
    local.layoutHandle = await picker().showSaveFilePicker!({ suggestedName, types: [{ description: 'Layout', accept: { 'application/json': ['.json'] } }] });
    return true;
  } catch {
    return false;
  }
}

export { OPENED_DIR };
