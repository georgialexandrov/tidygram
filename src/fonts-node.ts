import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHROME_UA, type Fetcher } from './scene/fonts.ts';

/** Where downloaded font files and stylesheets live between renders. */
export const FONT_CACHE_DIR = process.env.TIDYGRAM_CACHE || join(homedir(), '.cache', 'tidygram', 'fonts');

/** Stylesheets name woff2 files that Google rotates, so they expire; the woff2 files are addressed by URL and never do. */
export const CSS_TTL_MS = 30 * 24 * 3600 * 1000;

const keyOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(-150);

/**
 * Node fetcher with an on-disk cache: the first render online downloads, every
 * later one (online or not) reads the cache. Offline with no cache gives
 * `undefined`, which callers treat as "use system fonts".
 */
export function diskCachedFetcher(dir = FONT_CACHE_DIR, fetchImpl: typeof fetch = fetch, now = () => Date.now()): Fetcher {
  // TIDYGRAM_OFFLINE=1 skips the network entirely (tests, planes).
  const offline = !!process.env.TIDYGRAM_OFFLINE;
  return async (url, kind) => {
    const path = join(dir, keyOf(url));
    const cached = existsSync(path);
    const stale = cached && kind === 'css' && now() - statSync(path).mtimeMs > CSS_TTL_MS;
    if (cached && !stale) return new Uint8Array(readFileSync(path));
    const old = () => (cached ? new Uint8Array(readFileSync(path)) : undefined);
    if (offline) return old();
    try {
      const r = await fetchImpl(url, { headers: kind === 'css' ? { 'user-agent': CHROME_UA } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return old();
      const bytes = new Uint8Array(await r.arrayBuffer());
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, bytes);
      return bytes;
    } catch {
      return old();
    }
  };
}
