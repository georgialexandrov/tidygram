/** `diagram.puml` → `diagram.layout.json`, next to it. */
export function layoutPathFor(pumlPath: string): string {
  return pumlPath.replace(/\.(puml|plantuml|pu)$/i, '') + '.layout.json';
}
