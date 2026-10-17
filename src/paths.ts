/** Diagram sources the tool reads: PlantUML and Mermaid. */
export const DIAGRAM_FILE = /\.(puml|plantuml|pu|mmd|mermaid)$/i;

/** `diagram.puml` (or `.mmd`) → `diagram.layout.json`, next to it. */
export function layoutPathFor(pumlPath: string): string {
  return pumlPath.replace(DIAGRAM_FILE, '') + '.layout.json';
}
