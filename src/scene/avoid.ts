/* eslint-disable @typescript-eslint/no-explicit-any */
import { AvoidLib } from 'libavoid-js';

/**
 * Thin wrapper over the parts of libavoid (Adaptagrams' orthogonal connector
 * router, compiled to WASM) that we use. Its bundled typings don't match the
 * runtime names, so the surface is typed here.
 */
export type Avoid = any;

let instance: Avoid | undefined;

export async function loadAvoid(wasmPathOrUrl: string): Promise<Avoid> {
  if (!instance) {
    await AvoidLib.load(wasmPathOrUrl);
    instance = AvoidLib.getInstance();
  }
  return instance;
}

export const CONN_DIR_ALL = 15;

/** The router, if something has loaded it already (auto layout uses it to judge candidates, but never loads it itself). */
export function loadedAvoid(): Avoid | undefined {
  return instance;
}
