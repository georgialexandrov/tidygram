/**
 * Web fonts shared by the editor (a Google Fonts `<link>`), SVG/PNG export
 * (`@font-face` with data URIs) and the CLI (same, cached on disk). Pure and
 * DOM-free: callers inject how bytes are fetched.
 */

export interface WebFont {
  family: string;
  /** Weights to load; omitted for a single-weight family. */
  weights?: number[];
  /** Load the italic style as well. */
  italic?: boolean;
}

/** Faces of the paper themes: sans, mono, and a serif italic for notes. */
export const PAPER_WEB_FONTS: WebFont[] = [
  { family: 'Geist', weights: [400, 500, 600] },
  { family: 'Geist Mono', weights: [400, 500] },
  { family: 'Instrument Serif', italic: true },
];

/** The Google Fonts CSS2 URL for a list of families. */
export function googleFontsUrl(fonts: WebFont[]): string {
  const families = fonts.map((f) => {
    const name = f.family.replace(/ /g, '+');
    const w = f.weights;
    if (f.italic && w) return `${name}:ital,wght@${[0, 1].flatMap((i) => w.map((x) => `${i},${x}`)).join(';')}`;
    if (f.italic) return `${name}:ital@0;1`;
    if (w) return `${name}:wght@${w.join(';')}`;
    return name;
  });
  return `https://fonts.googleapis.com/css2?family=${families.join('&family=')}&display=swap`;
}

export interface FontFace {
  family: string;
  style: string;
  /** `400` or a range such as `400 600`. */
  weight: string;
  url: string;
}

/**
 * The Latin faces of a Google Fonts stylesheet (what diagram text needs; the
 * other subsets would multiply the size of every exported SVG). Faces of a
 * variable font point at one file for every weight; those merge into one
 * face with a weight range.
 */
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    if (m[1] !== 'latin') continue;
    const body = m[2]!;
    const family = /font-family:\s*['"]?([^;'"]+)['"]?/.exec(body)?.[1];
    const url = /url\(([^)]+)\)/.exec(body)?.[1]?.replace(/['"]/g, '');
    if (!family || !url) continue;
    const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal';
    const weight = /font-weight:\s*(\d+)/.exec(body)?.[1] ?? '400';
    const same = faces.find((f) => f.url === url && f.family === family && f.style === style);
    if (same) {
      const [lo, hi] = same.weight.split(' ').map(Number) as [number, number?];
      same.weight = `${Math.min(lo, Number(weight))} ${Math.max(hi ?? lo, Number(weight))}`;
    } else faces.push({ family, style, weight, url });
  }
  return faces;
}

/** Fetches bytes (or text) from a URL; `undefined` when unavailable. Injected so tests and the CLI cache stay out of this module. */
export type Fetcher = (url: string, kind: 'css' | 'font') => Promise<Uint8Array | undefined>;

const base64 = (bytes: Uint8Array) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * `@font-face` rules with the woff2 files inlined as data URIs, for an SVG
 * `<style>`. Empty string when anything is unavailable (offline): the SVG then
 * simply falls back to the theme's system font stack.
 */
export async function embeddedFontCss(fonts: WebFont[] | undefined, fetcher: Fetcher): Promise<string> {
  if (!fonts?.length) return '';
  try {
    const css = await fetcher(googleFontsUrl(fonts), 'css');
    if (!css) return '';
    const faces = parseFontFaces(new TextDecoder().decode(css));
    const rules: string[] = [];
    for (const f of faces) {
      const bytes = await fetcher(f.url, 'font');
      if (!bytes) return '';
      rules.push(`@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};src:url(data:font/woff2;base64,${base64(bytes)}) format('woff2');}`);
    }
    return rules.join('\n');
  } catch {
    return '';
  }
}

/** A browser or Node fetcher without a disk cache; results are memoised per URL. */
export function memoFetcher(): Fetcher {
  const seen = new Map<string, Promise<Uint8Array | undefined>>();
  return (url, kind) => {
    let p = seen.get(url);
    if (!p) {
      p = fetch(url, kind === 'css' ? { headers: typeof window === 'undefined' ? { 'user-agent': CHROME_UA } : {} } : {})
        .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined))
        .catch(() => undefined);
      seen.set(url, p);
      void p.then((v) => v || seen.delete(url));
    }
    return p;
  };
}

/** Google serves woff2 to browsers it knows; Node's default user agent would get TrueType. */
export const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
