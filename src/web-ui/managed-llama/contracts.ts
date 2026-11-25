import type { ChildProcess, SpawnOptions } from "node:child_process";

export class ManagedLlamaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ManagedLlamaError";
  }
}

export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ManagedLlamaError(code, message);
}

/** Pinned archive identity; sha256 is lowercase hexadecimal without a prefix. */
export interface Release {
  readonly tag: string;
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface LaunchSettings {
  modelPath: string;
  port: number;
  alias: string;
  contextTokens: number;
  gpuLayers: number;
}

export type Downloader = (release: Release, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
export type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
export type Health = (port: number, token: string, alias: string, signal: AbortSignal) => Promise<boolean>;

export interface Dependencies {
  platform?: { os: string; arch: string };
  download?: Downloader;
  spawn?: Spawn;
  health?: Health;
}

/** Bounds for later lifecycle implementations; defining them performs no work. */
export const LIMITS = Object.freeze({
  expandedBytes: 268435456,
  files: 4096,
  downloadMs: 120000,
  readyMs: 120000,
  stopMs: 5000,
  killMs: 3000,
});
