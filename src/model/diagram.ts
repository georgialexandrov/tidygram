import { parsePuml, type ParseOptions, type ParseResult } from './parse.ts';
import { looksLikeMermaid, parseMermaid } from './mermaid.ts';
import { looksLikeDrawio, parseDrawio } from './drawio.ts';
import { c4View, c4Views } from './c4-views.ts';

/**
 * The one entry for reading a diagram file. draw.io XML (`<mxfile>` or
 * `<mxGraphModel>` at the top) is recognised by content, whatever the file is
 * called. A source with `@start` is PlantUML; otherwise the extension decides
 * (`.mmd`/`.mermaid` vs `.puml`/`.plantuml`/`.pu`), and without a file name
 * a recognised Mermaid header line (`flowchart LR`, `sequenceDiagram`, ...)
 * does. PlantUML stays the default because it accepts files without tags.
 * `options.page` picks a page of a multi-page draw.io file (other formats have one),
 * `options.view` a C4 zoom level (see `c4-views.ts`).
 */
export function parseDiagram(source: string, fileName?: string, options: ParseOptions = {}): ParseResult {
  if (looksLikeDrawio(source) || (fileName && /\.drawio(\.xml)?$/i.test(fileName))) return parseDrawio(source, options);
  if (/^\s*@start/m.test(source)) return withViews(parsePuml(source), options.view);
  if (fileName && /\.(mmd|mermaid)$/i.test(fileName)) return parseMermaid(source);
  if (fileName && /\.(puml|plantuml|pu)$/i.test(fileName)) return withViews(parsePuml(source), options.view);
  return looksLikeMermaid(source) ? parseMermaid(source) : withViews(parsePuml(source), options.view);
}

/** C4 zoom levels: lists them, and shows the asked one (an unknown key is a warning, the diagram stays as written). */
function withViews(result: ParseResult, view: string | undefined): ParseResult {
  const views = c4Views(result.diagram);
  if (!views.length) return view ? { ...result, warnings: [...result.warnings, { line: 0, text: view, message: 'this diagram has no C4 views' }] } : result;
  if (!view) return { ...result, views };
  if (!views.some((v) => v.key === view)) return { ...result, views, warnings: [...result.warnings, { line: 0, text: view, message: `no such view; views: ${views.map((v) => v.key).join(', ')}` }] };
  return { ...result, views, view, diagram: c4View(result.diagram, view) };
}
