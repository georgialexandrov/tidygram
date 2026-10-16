import type { LayoutFile } from '../layout/layout-file.ts';
import type { Diagram } from '../model/types.ts';
import type { Avoid } from './avoid.ts';
import { buildScene, type BuildOptions, type Scene } from './scene.ts';
import { buildSequenceScene, type SequenceScene } from './sequence.ts';
import { buildGanttScene, buildTimingScene, type GanttScene, type TimingScene } from './gantt.ts';

/** Any renderable scene: free graph layouts, or the ordered layouts (sequence, ...). */
export type AnyScene = Scene | SequenceScene | GanttScene | TimingScene;

export function buildAnyScene(diagram: Diagram, layout: LayoutFile, avoid: Avoid, options: BuildOptions = {}): AnyScene {
  const special = diagram.special;
  if (special?.type === 'sequence') return buildSequenceScene(special, layout);
  if (special?.type === 'gantt') return buildGanttScene(special, layout);
  if (special?.type === 'timing') return buildTimingScene(special, layout);
  return buildScene(diagram, layout, avoid, options);
}
