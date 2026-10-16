import type { Point } from '../layout/layout-file.ts';
import type { Box } from './containers.ts';

export const FRAME_MARGIN = 24;

export const FRAME_PRESETS: { label: string; frame: Point }[] = [
  { label: '16:9 slide', frame: [16, 9] },
  { label: '4:3', frame: [4, 3] },
  { label: '1:1 square', frame: [1, 1] },
  { label: '3:4 portrait', frame: [3, 4] },
  { label: 'A4 landscape', frame: [297, 210] },
  { label: 'A4 portrait', frame: [210, 297] },
  { label: '21:9 wide', frame: [21, 9] },
];

/** Smallest rectangle of the frame's aspect ratio that holds `bounds` plus a margin, centred on it. */
export function frameRect(bounds: Box, frame: Point, margin = FRAME_MARGIN): Box {
  const ratio = frame[0] / frame[1];
  let w = bounds.w + margin * 2;
  let h = bounds.h + margin * 2;
  if (w / h < ratio) w = h * ratio;
  else h = w / ratio;
  return { x: bounds.x + bounds.w / 2 - w / 2, y: bounds.y + bounds.h / 2 - h / 2, w, h };
}
