import { parsePuml, type ParseResult } from './parse.ts';
import { looksLikeMermaid, parseMermaid } from './mermaid.ts';

/**
 * The one entry for reading a diagram file. A source with `@start` is
 * PlantUML whatever it is called; otherwise the extension decides
 * (`.mmd`/`.mermaid` vs `.puml`/`.plantuml`/`.pu`), and without a file name
 * a recognised Mermaid header line (`flowchart LR`, `sequenceDiagram`, ...)
 * does. PlantUML stays the default because it accepts files without tags.
 */
export function parseDiagram(source: string, fileName?: string): ParseResult {
  if (/^\s*@start/m.test(source)) return parsePuml(source);
  if (fileName && /\.(mmd|mermaid)$/i.test(fileName)) return parseMermaid(source);
  if (fileName && /\.(puml|plantuml|pu)$/i.test(fileName)) return parsePuml(source);
  return looksLikeMermaid(source) ? parseMermaid(source) : parsePuml(source);
}
