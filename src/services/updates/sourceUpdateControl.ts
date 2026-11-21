/**
 * Returns true when a plugin signals that updates for its source should pause
 * (e.g. rate-limit or anti-bot pacing). Matches by Error.name so subclasses
 * compiled to ES5 plugin bundles are recognized reliably.
 */
export const isSourceUpdatePausedError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'SourceUpdatePaused';
