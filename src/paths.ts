/**
 * Diagram sources the tool reads: PlantUML, Mermaid and draw.io. A plain
 * `.xml` only counts when it holds draw.io XML (the server sniffs it).
 */
export const DIAGRAM_FILE = /\.(puml|plantuml|pu|mmd|mermaid|drawio\.xml|drawio|xml)$/i;

/**
 * `diagram.puml` (or `.mmd`, `.drawio`, `.drawio.xml`) → `diagram.layout.json`,
 * next to it. Same stem, same sidecar: keep `x.drawio` and `x.puml` in
 * different folders.
 */
export function layoutPathFor(pumlPath: string): string {
  return pumlPath.replace(DIAGRAM_FILE, '') + '.layout.json';
}

/**
 * Default name for a converted copy: `diagram.puml` → `diagram-mermaid.mmd`.
 * A different stem on purpose: `diagram.mmd` next to `diagram.puml` would
 * share `diagram.layout.json` with it.
 */
export function convertedPathFor(path: string, target: string, extension: string): string {
  return `${path.replace(DIAGRAM_FILE, '')}-${target}${extension}`;
}
