// Bundled sample diagrams for the static demo: every fixture source, compiled in as raw text.
// Sidecars (*.layout.json) are not matched, so samples always start from the engine's own layout.
const modules = import.meta.glob('../../fixtures/**/*.{puml,plantuml,pu,mmd,mermaid,drawio,xml}', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const PREFIX = '../../fixtures/';
const byPath = new Map(Object.entries(modules).map(([k, v]) => [k.slice(PREFIX.length), v]));

/** Sample paths relative to fixtures/, top level first. */
export function sampleList(): string[] {
  return [...byPath.keys()].sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b));
}

export async function sampleSource(file: string): Promise<string | undefined> {
  return byPath.get(file)?.();
}
