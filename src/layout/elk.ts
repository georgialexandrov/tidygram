import ELK from 'elkjs/lib/elk.bundled.js';

/** Anything with ELK's `layout` method: the in-process bundle, or a worker-backed instance. */
export type ElkLike = Pick<InstanceType<typeof ELK>, 'layout'>;

let factory: () => ElkLike = () => new ELK();

/**
 * Where layouts run. Defaults to the in-process bundle (CLI, tests). The
 * editor installs a pool of Web Workers so independent layouts, like the
 * fit-to-frame candidates, run in parallel and off the main thread.
 */
export function setElkFactory(next: () => ElkLike): void {
  factory = next;
}

export function elk(): ElkLike {
  return factory();
}
