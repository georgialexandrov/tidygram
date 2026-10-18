import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHROME_UA, type Fetcher } from './scene/fonts.ts';

/** Where downloaded font files and stylesheets live between renders. */
export const FONT_CACHE_DIR = join(homedir(), '.cache', 'puml-layout', 'fonts');

const keyOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(-150);

/**
 * Node fetcher with an on-disk cache: the first render online downloads, every
 * later one (online or not) reads the cache. Offline with no cache gives
 * `undefined`, which callers treat as "use system fonts".
 */
export function diskCachedFetcher(dir = FONT_CACHE_DIR, fetchImpl: typeof fetch = fetch): Fetcher {
  return async (url, kind) => {
    const path = join(dir, keyOf(url));
    if (existsSync(path)) return new Uint8Array(readFileSync(path));
    try {
      const r = await fetchImpl(url, { headers: kind === 'css' ? { 'user-agent': CHROME_UA } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return undefined;
      const bytes = new Uint8Array(await r.arrayBuffer());
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  };
}
