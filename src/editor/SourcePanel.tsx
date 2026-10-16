import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Read-only view of the diagram source (never edited: the original belongs
 * to its author) and of the live layout.json. Lines of the selected elements
 * are highlighted; clicking a line selects what it declares.
 */

interface Props {
  file: string;
  source: string;
  layoutJson: string;
  highlighted: ReadonlySet<number>;
  onLineClick(line: number): void;
  onClose(): void;
}

const KEYWORDS = /\b(actor|usecase|rectangle|package|frame|node|folder|cloud|database|note|end note|as|of|left|right|top|bottom|direction|to|skinparam|title)\b/g;

/** Minimal PlantUML colouring: comments, strings, stereotypes, arrows, keywords. */
function colour(line: string): ReactNode[] {
  if (/^\s*'/.test(line)) return [<span key="c" className="tok-comment">{line}</span>];
  if (/^\s*@/.test(line)) return [<span key="d" className="tok-directive">{line}</span>];
  const tokens: ReactNode[] = [];
  const re = /("[^"]*")|(<<[^>]*>>)|(\([^)]*\))|((?:<\|?|<)?[-.]+(?:\[[^\]]*\])?(?:\|>|>)?(?=\s|$))|(:[^:\n]+:)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (text: string, key: string) => {
    const parts: ReactNode[] = [];
    let i = 0;
    for (const k of text.matchAll(KEYWORDS)) {
      if (k.index! > i) parts.push(text.slice(i, k.index));
      parts.push(
        <span key={`${key}k${k.index}`} className="tok-keyword">
          {k[0]}
        </span>,
      );
      i = k.index! + k[0].length;
    }
    parts.push(text.slice(i));
    return parts;
  };
  while ((m = re.exec(line))) {
    if (m.index > last) tokens.push(...plain(line.slice(last, m.index), `p${last}`));
    const cls = m[1] || m[5] ? 'tok-string' : m[2] ? 'tok-stereo' : m[3] ? 'tok-usecase' : 'tok-arrow';
    tokens.push(
      <span key={`t${m.index}`} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) tokens.push(...plain(line.slice(last), `p${last}`));
  return tokens;
}

export function SourcePanel({ file, source, layoutJson, highlighted, onLineClick, onClose }: Props) {
  const [tab, setTab] = useState<'source' | 'layout'>('source');
  const body = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => source.split(/\r?\n/), [source]);

  // Bring the first highlighted line into view when the selection changes.
  useEffect(() => {
    if (tab !== 'source' || !highlighted.size) return;
    const first = Math.min(...highlighted);
    body.current?.querySelector(`[data-line="${first}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, tab]);

  return (
    <aside className="source-panel">
      <div className="source-tabs">
        <button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')} title="The original, read-only">
          {file.split('/').pop()}
        </button>
        <button className={tab === 'layout' ? 'active' : ''} onClick={() => setTab('layout')} title="Your changes: the sidecar file">
          layout.json
        </button>
        <span className="spacer" />
        <button onClick={() => void navigator.clipboard?.writeText(tab === 'source' ? source : layoutJson)} title="Copy">
          Copy
        </button>
        <button onClick={onClose} title="Close (S)">
          ×
        </button>
      </div>
      <div className="source-body" ref={body}>
        {tab === 'source' ? (
          lines.map((line, i) => (
            <div key={i} data-line={i + 1} className={`src-line${highlighted.has(i + 1) ? ' hl' : ''}`} onClick={() => onLineClick(i + 1)}>
              <span className="ln">{i + 1}</span>
              <span className="code">{colour(line)}</span>
            </div>
          ))
        ) : (
          <pre className="layout-json">{layoutJson}</pre>
        )}
      </div>
      {tab === 'source' && <div className="source-note">Read-only: the source belongs to its author. Your changes live in layout.json.</div>}
    </aside>
  );
}
