import type { ToolRequestDisposer } from "./tool-media.js";

/** Request-local effects that remain active after a tool returned. */
export type ToolRequestWork = Readonly<{
  trackUntil(settled: Promise<void>): void;
}>;

/** Plugin-owned JSON data, restored only when the owner is instantiated. */
export type ToolRequestState = Readonly<{
  read(key: string): unknown;
  register(
    key: string,
    codec: Readonly<{ snapshot(): unknown; dispose?(): void | Promise<void> }>,
  ): void;
}>;
export type ToolRequestPreparationContext = Readonly<{
  requestState?: ToolRequestState;
  onRequestDispose?: ToolRequestDisposer;
}>;
