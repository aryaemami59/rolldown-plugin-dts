declare global {
  interface ImportMeta {
    /**
     * The URL of the `tsc` worker script, injected at build time via the
     * `define` option in `tsdown.config.ts` (`'./tsc-worker.mjs'` in the
     * published bundle). When undefined (e.g. when running from source),
     * the plugin falls back to `'./tsc/worker.ts'`.
     */
    WORKER_URL?: string
  }
}

export {}
