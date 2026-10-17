import { LINE_HEIGHT, type TextBlock } from '../scene/measure.ts';
import type { Theme } from '../scene/theme.ts';

export const f = (n: number) => Math.round(n * 10) / 10;

/** Tracking for small caps titles; `template.ts` measures caps with the same 0.08em. */
export const CAPS_TRACKING = '0.08em';

interface TextProps {
  theme: Theme;
  block: TextBlock;
  /** x of the anchor: centre for `middle`, left edge for `start`, right edge for `end`. */
  cx: number;
  top: number;
  align?: 'middle' | 'start' | 'end';
  weight?: number | 'bold';
  fill?: string;
  caps?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Figures of equal width, for numbers that line up (dates, ticks, sequence numbers). */
  tabular?: boolean;
  /**
   * Lines that are a bracketed technology (`[HTTPS]`, C4 relation labels)
   * are secondary: drawn in this colour instead of `fill`.
   */
  quietBrackets?: string;
  /** A knock-out outline in this colour behind the glyphs, for text that sits on lines (multiplicities, addresses). */
  halo?: string;
}

export function Text({ theme, block, cx, top, align = 'middle', weight, fill, caps, italic, underline, tabular, quietBrackets, halo }: TextProps) {
  const lineH = block.size * LINE_HEIGHT;
  return (
    <text
      fontFamily={theme.font}
      fontSize={f(block.size * 100) / 100}
      fontWeight={weight}
      fontStyle={italic ? 'italic' : undefined}
      textDecoration={underline ? 'underline' : undefined}
      textAnchor={align}
      fill={fill ?? theme.colors.text}
      letterSpacing={caps ? CAPS_TRACKING : undefined}
      stroke={halo}
      strokeWidth={halo ? Math.max(2.5, block.size * 0.28) : undefined}
      strokeLinejoin={halo ? 'round' : undefined}
      paintOrder={halo ? 'stroke' : undefined}
      style={tabular ? { pointerEvents: 'none', userSelect: 'none', fontVariantNumeric: 'tabular-nums' } : { pointerEvents: 'none', userSelect: 'none' }}
    >
      {block.lines.map((line, i) => (
        <tspan
          key={i}
          x={f(cx)}
          y={f(top + i * lineH + (lineH - block.size) / 2 + block.size * 0.8)}
          fill={quietBrackets && /^\[.*\]$/.test(line) ? quietBrackets : undefined}
          fontWeight={quietBrackets && /^\[.*\]$/.test(line) ? 400 : undefined}
        >
          {caps ? line.toUpperCase() : line}
        </tspan>
      ))}
    </text>
  );
}
