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
