import { useEffect, useState } from 'react';
import { googleFontsUrl, type WebFont } from '../scene/fonts.ts';

/** Adds the Google Fonts stylesheet once per URL; returns the link. */
export function injectFontLink(fonts: WebFont[], doc: Document = document): HTMLLinkElement {
  const href = googleFontsUrl(fonts);
  const existing = [...doc.head.querySelectorAll<HTMLLinkElement>('link[data-web-fonts]')].find((l) => l.href === href);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.webFonts = '';
  doc.head.append(link);
  return link;
}

/**
 * Loads the active theme's web fonts. Returns a counter that bumps once the
 * faces are usable, so the caller can rebuild the scene (text widths are
 * measured by table, but the redraw must happen with the real faces).
 */
export function useWebFonts(fonts: WebFont[] | undefined): number {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (!fonts) return;
    let live = true;
    const link = injectFontLink(fonts);
    const ready = () =>
      Promise.all(fonts.flatMap((f) => (f.weights ?? [400]).flatMap((w) => [document.fonts.load(`${w} 12px "${f.family}"`), ...(f.italic ? [document.fonts.load(`italic ${w} 12px "${f.family}"`)] : [])])))
        .then(() => document.fonts.ready)
        .then(() => live && setLoaded((n) => n + 1))
        .catch(() => undefined);
    if (link.sheet) void ready();
    else link.addEventListener('load', () => void ready(), { once: true });
    return () => {
      live = false;
    };
  }, [fonts]);
  return loaded;
}
