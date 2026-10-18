import { memo, useCallback, useEffect, useState } from 'react';

/**
 * C4 zoom levels in the toolbar: "As written" (the source as it stands, the
 * sidecar's top level) and the views the file offers (`ParseResult.views`:
 * context, a container view per system, a component view per container
 * boundary). Each keeps its own layout under the sidecar's `views`.
 */
export const ViewSwitcher = memo(function ViewSwitcher({
  views,
  value,
  onChange,
}: {
  views?: { key: string; label: string }[];
  value?: string;
  onChange(view: string | undefined): void;
}) {
  if (!views?.length) return null;
  return (
    <select
      className="page-select view-select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      title="C4 zoom level: each view has its own layout in layout.json"
      aria-label="View"
    >
      <option value="">As written</option>
      {views.map((v) => (
        <option key={v.key} value={v.key}>
          {v.label}
        </option>
      ))}
    </select>
  );
});

/** The view on screen, deep-linked as `?view=<key>` (absent: as written). */
export function useViewParam(): [string | undefined, (view: string | undefined) => void] {
  const [view, setView] = useState<string | undefined>(() => new URLSearchParams(location.search).get('view') ?? undefined);
  useEffect(() => {
    const url = new URL(location.href);
    if (view === undefined) url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    if (url.href !== location.href) history.replaceState(null, '', url);
  }, [view]);
  return [view, useCallback((next: string | undefined) => setView(next), [])];
}
