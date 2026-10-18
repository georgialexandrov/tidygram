import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pumlFiles } from './src/server/plugin.ts';

// PUML_ROOT points the editor at another folder of diagrams; defaults to this repo.
const root = process.env.PUML_ROOT ?? process.cwd();
// `pnpm build:demo` (DEMO=1): a static site with no server plugin; bundled samples, files opened in the browser.
// DEMO_BASE is the sub-path it is served under (GitHub Pages: `/repo-name/`); './' works from any folder.
const demo = process.env.DEMO === '1';

export default defineConfig({
  base: demo ? (process.env.DEMO_BASE ?? './') : '/',
  define: { __DEMO__: JSON.stringify(demo) },
  plugins: demo ? [react()] : [react(), pumlFiles(root)],
  server: { port: 5199 },
});
