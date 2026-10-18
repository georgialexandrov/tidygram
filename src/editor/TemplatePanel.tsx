import { memo, useState } from 'react';
import { bandsKind, TEMPLATE_KINDS, type TemplateKind, type TemplateRules } from '../layout/layout-file.ts';
import { Popover } from './Popover.tsx';
import { TEMPLATE_LABEL } from '../layout/template/defs.ts';
import type { TemplateScene } from '../scene/template.ts';

/** Template pictograms, drawn like the toolbar's other glyphs: stacked bars, a hexagon, rings; a dotted square for none. */
export function TemplateGlyph({ kind }: { kind: TemplateKind | null }) {
  return (
    <svg className={`template-glyph${kind ? ' on' : ''}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {kind === 'layered' && <path d="M1 2.5h12M1 7h12M1 11.5h12" />}
      {kind === 'tiers' && <path d="M5.5 2.5h3M1 7h12M8 11.5h5" />}
      {kind === 'hexagonal' && <path d="M4 1.5h6L13 7l-3 5.5H4L1 7z" />}
      {kind === 'clean' && (
        <>
          <circle cx="7" cy="7" r="5.75" />
          <circle cx="7" cy="7" r="2.5" />
        </>
      )}
      {kind === null && <path d="M1.5 1.5h11v11h-11z" strokeDasharray="2 2" />}
    </svg>
  );
}

const HINT: Record<TemplateKind, string> = { layered: 'bands, top to bottom', hexagonal: 'ports & adapters', clean: 'rings, inside out', tiers: 'people, system, externals' };

function rulesTitle(kind: TemplateKind, rules: TemplateRules): string {
  if (rules === 'off') return 'Flag nothing';
  if (kind === 'tiers') return rules === 'relaxed' ? 'Flag lines that point up (a system calling a person, an external calling in)' : 'Also flag people using external systems directly';
  if (kind === 'layered') return rules === 'relaxed' ? 'Flag lines that point up (implementing an interface is fine)' : 'Also flag lines that skip a layer, and every upward realization';
  if (kind === 'clean') return rules === 'relaxed' ? 'Flag lines that point outward (adapters may use their drivers)' : 'Flag every outward line';
  return 'Flag adapters that bypass the ports, and a core or port that uses an adapter';
}

/**
 * The toolbar's template key and its menu: None / Layered / Hexagonal / Clean,
 * and the rule set while one is on. Memoized: the editor re-renders on every
 * drag frame, this only when the template changes.
 */
export const TemplatePicker = memo(function TemplatePicker({
  kind,
  rules,
  disabled,
  onPick,
  onRules,
}: {
  kind: TemplateKind | null;
  rules: TemplateRules | null;
  disabled: boolean;
  onPick(kind: TemplateKind | null): void;
  onRules(rules: TemplateRules): void;
}) {
  return (
    <Popover
      label={
        <>
          <TemplateGlyph kind={kind} />
          <span className="template-name">{kind ? TEMPLATE_LABEL[kind] : 'Template'}</span>
        </>
      }
      title="Architecture template: layers as bands, a hexagon or rings"
      className={`template-menu${kind ? ' on' : ''}`}
      disabled={disabled}
    >
      {(close) => (
        <div className="menu" role="menu">
          {([null, ...TEMPLATE_KINDS] as (TemplateKind | null)[]).map((k) => (
            <button key={k ?? 'none'} role="menuitemradio" aria-checked={kind === k} data-template={k ?? 'none'} onClick={() => (close(), onPick(k))}>
              <span className="menu-label">
                <TemplateGlyph kind={k} />
                {k ? TEMPLATE_LABEL[k] : 'None'}
              </span>
              <span className="hint">{k ? HINT[k] : kind ? 'back to the free layout' : 'free layout'}</span>
            </button>
          ))}
          {kind && rules && (
            <>
              <span className="menu-rule" aria-hidden="true" />
              <div className="field template-rules">
                <span className="field-label">Rules</span>
                <span className="segmented" role="radiogroup" aria-label="Dependency rules">
                  {(['relaxed', 'strict', 'off'] as const).map((r) => (
                    <button key={r} role="radio" aria-checked={rules === r} data-rules={r} title={rulesTitle(kind, r)} onClick={() => onRules(r)}>
                      {r}
                    </button>
                  ))}
                </span>
              </div>
              <p className="menu-note">Drag an element into another {bandsKind(kind) ? 'band' : kind === 'clean' ? 'ring' : 'zone'} to move it there.</p>
            </>
          )}
        </div>
      )}
    </Popover>
  );
});

interface Props {
  kind: TemplateKind;
  scene: TemplateScene;
  unassigned: string[];
  nameOf(id: string): string;
  selectedNodes: ReadonlySet<string>;
  selectedEdge?: string;
  onSelectNode(id: string): void;
  onSelectEdge(id: string): void;
}

/**
 * What the template found: dependency violations (yellow triangle, like the
 * warnings) and elements no signal placed. Floats bottom-left over the
 * canvas; collapses to its head. Clicking a row selects the line or element.
 */
function TemplatePanelImpl({ kind, scene, unassigned, nameOf, selectedNodes, selectedEdge, onSelectNode, onSelectEdge }: Props) {
  const [open, setOpen] = useState(true);
  const v = scene.violations.length;
  const u = unassigned.length;
  const layerLabel = (id: string) => scene.layers.find((l) => l.id === id)?.label ?? id;
  return (
    <section className={`template-panel${v ? ' has-violations' : ''}`} aria-label="Template findings" data-violations={v} data-unassigned={u}>
      <button className="template-panel-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="field-label">{TEMPLATE_LABEL[kind]}</span>
        <span className={`count${v ? ' warn' : ''}`}>
          {v > 0 && (
            <svg className="glyph" width="10" height="9" viewBox="0 0 12 11" aria-hidden="true">
              <path d="M6 0.5 11.5 10.5H0.5Z" />
            </svg>
          )}
          {v ? `${v} violation${v > 1 ? 's' : ''}` : 'no violations'}
        </span>
        {u > 0 && <span className="count">{u} unassigned</span>}
        <svg className="caret" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
          <path d={open ? 'M0 5h8L4 0z' : 'M0 0h8L4 5z'} />
        </svg>
      </button>
      {open && (v > 0 || u > 0) && (
        <ol className="template-panel-list">
          {scene.violations.map((x) => (
            <li key={x.edge}>
              <button className={selectedEdge === x.edge ? 'selected' : undefined} data-edge-ref={x.edge} onClick={() => onSelectEdge(x.edge)} title={x.edge}>
                <span className="row-what">
                  {nameOf(x.from)} → {nameOf(x.to)}
                </span>
                <span className="row-why">{x.message.split(': ').pop()}</span>
              </button>
            </li>
          ))}
          {unassigned.map((id) => (
            <li key={id}>
              <button className={selectedNodes.has(id) ? 'selected' : undefined} data-node-ref={id} onClick={() => onSelectNode(id)} title="No name, stereotype, container or line said where this goes: drag it into its layer">
                <span className="row-what">{nameOf(id)}</span>
                <span className="row-why">unassigned, in {layerLabel(scene.assigned.get(id) ?? '')}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const TemplatePanel = memo(TemplatePanelImpl);
