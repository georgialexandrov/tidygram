import type { LayoutFile } from '../layout/layout-file.ts';
import type { Diagram } from '../model/types.ts';
import type { AnyScene } from '../scene/any.ts';
import type { ConvertResult, ConvertTarget } from './common.ts';
import { toDrawio } from './drawio.ts';
import { toMermaid } from './mermaid.ts';
import { toPlantUml } from './plantuml.ts';

export type { ConvertResult, ConvertTarget, IdMap } from './common.ts';
export { toDrawio, toMermaid, toPlantUml };

/** File extension per target. */
export const TARGET_EXTENSION: Record<ConvertTarget, string> = { puml: '.puml', mermaid: '.mmd', drawio: '.drawio' };

/** Source format of a file name, so "convert to the same format" can be refused or offered sensibly. */
export function formatOf(fileName: string, source: string): ConvertTarget {
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?<(mxfile|mxGraphModel)\b/.test(source) || /\.drawio(\.xml)?$/i.test(fileName)) return 'drawio';
  if (/^\s*@start/m.test(source)) return 'puml';
  return /\.(mmd|mermaid)$/i.test(fileName) ? 'mermaid' : 'puml';
}

/**
 * One entry for every target. `layout` should be complete (after
 * `ensureLayout`): its positions are what the result carries. draw.io wants
 * the built `scene` for routed lines; without one it writes stored
 * checkpoints only.
 */
export function convert(diagram: Diagram, layout: LayoutFile, target: ConvertTarget, scene?: AnyScene): ConvertResult {
  if (target === 'drawio') return toDrawio(diagram, layout, scene);
  if (target === 'mermaid') return toMermaid(diagram, layout);
  return toPlantUml(diagram, layout);
}
