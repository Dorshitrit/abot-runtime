import type { ToolRequestState } from "../../capabilities/tool-request-resources.js";

/** Pending capsules remain data-only until an owning plugin registers its codec. */
export class RequestToolState {
  private readonly pending = new Map<string, unknown>();
  private readonly owners = new Map<
    string,
    Parameters<ToolRequestState["register"]>[1]
  >();
  private closed = false;
  readonly port: ToolRequestState = Object.freeze({
    read: (key) => {
      this.assertOpen();
      return structuredClone(this.pending.get(key));
    },
    register: (key, codec) => {
      this.assertOpen();
      if (!key || this.owners.has(key))
        throw new Error("tool_request_state_owner_conflict");
      this.owners.set(key, codec);
      this.pending.delete(key);
    },
  });
  snapshot(): Readonly<Record<string, unknown>> {
    this.assertOpen();
    return Object.fromEntries([
      ...this.pending,
      ...[...this.owners].map(
        ([key, codec]) => [key, captureJson(codec.snapshot())] as const,
      ),
    ]);
  }
  restore(value: unknown): void {
    this.assertOpen();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      this.pending.size ||
      this.owners.size
    )
      throw new Error("tool_request_state_invalid");
    for (const [key, entry] of Object.entries(value))
      this.pending.set(key, captureJson(entry));
  }
  assertRestoredStateClaimed(): void {
    if (this.pending.size)
      throw new Error("tool_request_state_owner_unavailable");
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const owners = [...this.owners.values()];
    this.pending.clear();
    this.owners.clear();
    await Promise.allSettled(
      owners.map((owner) => Promise.resolve().then(() => owner.dispose?.())),
    );
  }
  private assertOpen() {
    if (this.closed) throw new Error("tool_request_state_closed");
  }
}
function captureJson(value: unknown): unknown {
  const visit = (input: unknown, seen: Set<object>): void => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (typeof input !== "object" || seen.has(input))
      throw new Error("tool_request_state_not_serializable");
    const prototype = Object.getPrototypeOf(input);
    if (
      !Array.isArray(input) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new Error("tool_request_state_not_serializable");
    seen.add(input);
    for (const child of Object.values(input)) visit(child, seen);
    seen.delete(input);
  };
  visit(value, new Set());
  return structuredClone(value);
}
