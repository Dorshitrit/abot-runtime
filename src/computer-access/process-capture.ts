import type { Readable } from "node:stream";

/** Optional local output sink. Its owner handles storage, retention and delivery. */
export type SystemProcessCapture = Readonly<{
  attach(stdout: Readable, stderr: Readable, onFailure: () => void): void;
  end(): void;
}>;
