import { memo } from 'react';
import { hexPoints, RING_ASPECT, type TemplateScene, type TemplateTitle } from '../scene/template.ts';
import type { Theme } from '../scene/theme.ts';
import { f, Text } from './text.tsx';

/**
 * Template backgrounds: bands, hexagons and adapter panels, or rings, with
 * their titles. Drawn under everything and never hit-tested, so the canvas
 * behind them still pans and marquee-selects.
 */

function Title({ t, theme }: { t: TemplateTitle; theme: Theme }) {
  const caps = theme.containerTitle === 'caps';
  return <Text theme={theme} block={t.text} cx={t.x} top={t.y} align={t.align} weight={caps ? 600 : 'bold'} fill={theme.colors.layerTitle} caps={caps} />;
}

function TemplateBackdropImpl({ t, theme }: { t: TemplateScene; theme: Theme }) {
  const c = theme.colors;
  const radius = Math.max(2, theme.containerRadius);
  return (
    <g data-template={t.kind} style={{ pointerEvents: 'none' }}>
      {t.bands.map((b) => (
        <g key={b.id} data-layer={b.id}>
          <rect x={f(b.box.x)} y={f(b.box.y)} width={f(b.box.w)} height={f(b.box.h)} rx={radius} fill={b.fill} stroke={c.layerStroke} strokeWidth={1} />
          <Title t={b.title} theme={theme} />
        </g>
      ))}
      {t.hexagons.map((h) => (
        <g key={h.id} data-layer={h.id}>
          <polygon points={hexPoints(h.cx, h.cy, h.r).map(([x, y]) => `${f(x)},${f(y)}`).join(' ')} fill={h.fill} stroke={c.layerStroke} strokeWidth={1} strokeLinejoin="round" />
          <Title t={h.title} theme={theme} />
        </g>
      ))}
      {t.center &&
        // Outermost first, so each inner ring paints over the one around it.
        [...t.rings].reverse().map((r) => (
          <g key={r.id} data-layer={r.id}>
            <ellipse cx={f(t.center![0])} cy={f(t.center![1])} rx={f(r.r * RING_ASPECT)} ry={f(r.r)} fill={r.fill} stroke={c.layerStroke} strokeWidth={1} />
          </g>
        ))}
      {t.center && t.rings.map((r) => <Title key={r.id} t={r.title} theme={theme} />)}
    </g>
  );
}

export const TemplateBackdrop = memo(TemplateBackdropImpl);

/**
 * Editor only: the layer a dragged element would land in, outlined in the
 * focus blue while the drag is over it. Ports light up their side of the
 * hexagon's outline.
 */
export function TemplateHighlight({ t, layer, color }: { t: TemplateScene; layer: string; color: string }) {
  const stroke = { fill: 'none', stroke: color, strokeWidth: 2, strokeDasharray: '6 4', vectorEffect: 'non-scaling-stroke' as const, pointerEvents: 'none' as const };
  const band = t.bands.find((b) => b.id === layer);
  if (band) return <rect data-drop={layer} x={f(band.box.x - 3)} y={f(band.box.y - 3)} width={f(band.box.w + 6)} height={f(band.box.h + 6)} rx={6} {...stroke} />;
  const hex = t.hexagons.find((h) => h.id === layer);
  if (hex) return <polygon data-drop={layer} points={hexPoints(hex.cx, hex.cy, hex.r).map(([x, y]) => `${f(x)},${f(y)}`).join(' ')} {...stroke} />;
  const outer = t.hexagons[0];
  if (outer && (layer === 'inbound' || layer === 'outbound')) {
    const p = hexPoints(outer.cx, outer.cy, outer.r);
    const side = layer === 'inbound' ? [p[4]!, p[3]!, p[2]!] : [p[5]!, p[0]!, p[1]!];
    return <polyline data-drop={layer} points={side.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')} {...stroke} strokeWidth={4} strokeDasharray={undefined} strokeLinecap="round" />;
  }
  const ring = t.rings.find((r) => r.id === layer);
  if (ring && t.center) {
    const [cx, cy] = t.center;
    // The annulus: outer and inner outline.
    return (
      <g data-drop={layer}>
        <ellipse cx={f(cx)} cy={f(cy)} rx={f(ring.r * RING_ASPECT)} ry={f(ring.r)} {...stroke} />
        {ring.inner > 0 && <ellipse cx={f(cx)} cy={f(cy)} rx={f(ring.inner * RING_ASPECT)} ry={f(ring.inner)} {...stroke} />}
      </g>
    );
  }
  return null;
}
