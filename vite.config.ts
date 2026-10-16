import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pumlFiles } from './src/server/plugin.ts';

// PUML_ROOT points the editor at another folder of diagrams; defaults to this repo.
const root = process.env.PUML_ROOT ?? process.cwd();

export default defineConfig({
  plugins: [react(), pumlFiles(root)],
  server: { port: 5199 },
});
