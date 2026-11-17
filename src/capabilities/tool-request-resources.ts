import type { RuntimeToolPathResolver } from "./tool-types.js";
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
  /** Immutable owner of request-local references, including approval resume. */
  requestId?: string;
  /** Frozen request owner, shared by the root and every delegated call. */
  rootContractId?: string;
  /** Frozen model-selected route; absent for consumers without an EA/SUPER request. */
  executionPolicy?: string;
  /** Same immutable request roots used by execution, including approval resume. */
  runtimePathResolver?: RuntimeToolPathResolver;
  requestState?: ToolRequestState;
  onRequestDispose?: ToolRequestDisposer;
}>;
