import { LINE_HEIGHT, type TextBlock } from '../scene/measure.ts';
import type { Theme } from '../scene/theme.ts';

export const f = (n: number) => Math.round(n * 10) / 10;

interface TextProps {
  theme: Theme;
  block: TextBlock;
  /** x of the anchor: centre for `middle`, left edge for `start`. */
  cx: number;
  top: number;
  align?: 'middle' | 'start';
  weight?: number | 'bold';
  fill?: string;
  caps?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export function Text({ theme, block, cx, top, align = 'middle', weight, fill, caps, italic, underline }: TextProps) {
  const lineH = block.size * LINE_HEIGHT;
  return (
    <text
      fontFamily={theme.font}
      fontSize={block.size}
      fontWeight={weight}
      fontStyle={italic ? 'italic' : undefined}
      textDecoration={underline ? 'underline' : undefined}
      textAnchor={align}
      fill={fill ?? theme.colors.text}
      letterSpacing={caps ? '0.08em' : undefined}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      {block.lines.map((line, i) => (
        <tspan key={i} x={f(cx)} y={f(top + i * lineH + (lineH - block.size) / 2 + block.size * 0.8)}>
          {caps ? line.toUpperCase() : line}
        </tspan>
      ))}
    </text>
  );
}
