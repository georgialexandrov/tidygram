import { parsePuml, type ParseResult } from './parse.ts';
import { looksLikeMermaid, parseMermaid } from './mermaid.ts';
import { looksLikeDrawio, parseDrawio } from './drawio.ts';

/**
 * The one entry for reading a diagram file. draw.io XML (`<mxfile>` or
 * `<mxGraphModel>` at the top) is recognised by content, whatever the file is
 * called. A source with `@start` is PlantUML; otherwise the extension decides
 * (`.mmd`/`.mermaid` vs `.puml`/`.plantuml`/`.pu`), and without a file name
 * a recognised Mermaid header line (`flowchart LR`, `sequenceDiagram`, ...)
 * does. PlantUML stays the default because it accepts files without tags.
 */
export function parseDiagram(source: string, fileName?: string): ParseResult {
  if (looksLikeDrawio(source) || (fileName && /\.drawio(\.xml)?$/i.test(fileName))) return parseDrawio(source);
  if (/^\s*@start/m.test(source)) return parsePuml(source);
  if (fileName && /\.(mmd|mermaid)$/i.test(fileName)) return parseMermaid(source);
  if (fileName && /\.(puml|plantuml|pu)$/i.test(fileName)) return parsePuml(source);
  return looksLikeMermaid(source) ? parseMermaid(source) : parsePuml(source);
}
