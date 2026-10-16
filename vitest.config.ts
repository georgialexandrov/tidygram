import { defineConfig } from 'vitest/config';

// One file at a time: the routing test checks timing, and the fit tests would otherwise steal its CPU.
export default defineConfig({ test: { fileParallelism: false } });
