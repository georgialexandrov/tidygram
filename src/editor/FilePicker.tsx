import { memo, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from './Popover.tsx';
import { FORMAT_BADGE, filterFiles, formatOf, groupByFolder } from './selection.ts';

/** Format badge: label-font caps in a hairline box, the same width for all three so names line up. */
export function FormatBadge({ path }: { path: string }) {
  const format = formatOf(path);
  return (
    <span className={`badge badge-${format}`} title={format === 'plantuml' ? 'PlantUML' : format === 'mermaid' ? 'Mermaid' : 'draw.io'}>
      {FORMAT_BADGE[format]}
    </span>
  );
}

/**
 * The diagram picker: a key showing the open file's format and name, and a
 * panel with a filter field over every diagram the server lists, grouped by
 * folder. Typing narrows by path or format (`mmd`, `drawio`, `class`);
 * arrows move, Enter opens. A `<select>` stopped being usable once PlantUML,
 * Mermaid and draw.io files sat side by side with the same names.
 * Memoized: the editor re-renders on every pointer move of a drag, and the
 * list has a row per diagram.
 */
export const FilePicker = memo(function FilePicker({ files, file, onPick }: { files: string[]; file: string | null; onPick(path: string): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterFiles(files, query), [files, query]);
  const groups = useMemo(() => groupByFolder(shown), [shown]);
  /** Rows in display order (grouping can reorder the server's list); arrows and Enter walk this. */
  const flat = useMemo(() => groups.flatMap((g) => g.files.map((f) => f.path)), [groups]);
  const name = file?.split('/').pop() ?? 'Choose a diagram';

  const onOpenChange = (open: boolean) => {
    if (!open) return setQuery('');
    // Start on the open file, so arrows step to its neighbours.
    setActive(Math.max(0, groupByFolder(files).flatMap((g) => g.files.map((f) => f.path)).indexOf(file ?? '')));
    requestAnimationFrame(() => {
      input.current?.focus();
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  };

  const move = (to: number) => {
    const next = Math.max(0, Math.min(flat.length - 1, to));
    setActive(next);
    requestAnimationFrame(() => list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <Popover
      label={
        <span className="file-key">
          {file && <FormatBadge path={file} />}
          <span className="file-key-name">{name}</span>
        </span>
      }
      title={file ? `${file} — choose another diagram` : 'Choose a diagram'}
      className="file-picker"
      onOpenChange={onOpenChange}
    >
      {(close) => {
        const pick = (path: string | undefined) => {
          if (!path) return;
          close();
          if (path !== file) onPick(path);
        };
        const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), move(active + 1));
          else if (e.key === 'ArrowUp') (e.preventDefault(), move(active - 1));
          else if (e.key === 'Enter') (e.preventDefault(), pick(flat[active]));
        };
        let index = 0;
        return (
          <div className="picker">
            <input
              ref={input}
              className="picker-filter"
              type="search"
              value={query}
              placeholder={`Filter ${files.length} diagrams: name, folder, puml, mmd, drawio`}
              aria-label="Filter diagrams"
              aria-controls="picker-list"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
            />
            <div className="picker-list" id="picker-list" role="listbox" ref={list} aria-label="Diagrams">
              {groups.map((g) => (
                <div key={g.folder} role="group" aria-label={g.folder}>
                  <div className="picker-folder">{g.folder === '.' ? 'top level' : g.folder}</div>
                  {g.files.map((f) => {
                    const i = index++;
                    return (
                      <div
                        key={f.path}
                        role="option"
                        data-index={i}
                        data-path={f.path}
                        aria-selected={i === active}
                        className={`picker-row${f.path === file ? ' current' : ''}`}
                        title={f.path}
                        onPointerMove={() => i !== active && setActive(i)}
                        onClick={() => pick(f.path)}
                      >
                        <span className="picker-lamp" aria-hidden="true" />
                        <FormatBadge path={f.path} />
                        <span className="picker-name">{f.name}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {!shown.length && <div className="picker-empty">No diagram matches “{query}”.</div>}
            </div>
            <div className="picker-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>Esc</kbd> close
              </span>
              <span>
                {shown.length} of {files.length}
              </span>
            </div>
          </div>
        );
      }}
    </Popover>
  );
});
