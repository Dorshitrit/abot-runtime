import type { ServerResponse } from "node:http";
import { sendJson } from "../local-runtime/http.js";

/** One installation owns one in-flight computer setup across connection routes. */
export class HostSetupMutation {
  private pending?: Promise<void>;

  get busy(): boolean { return this.pending !== undefined; }

  rejectConcurrentMutation(response: ServerResponse): boolean {
    if (!this.busy) return false;
    sendJson(response, 409, { ok: false, error: "host_setup_in_progress",
      message: "Computer access is being connected. Wait for setup to finish." });
    return true;
  }

  async run(response: ServerResponse, operation: () => Promise<void>): Promise<void> {
    if (this.rejectConcurrentMutation(response)) return;
    const pending = Promise.resolve().then(operation);
    this.pending = pending;
    try {
      await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async close(): Promise<void> { await this.pending?.catch(() => undefined); }
}
