import { isSessionDeletedError } from "./session-lifecycle-store.js";
import type { SessionTerminalMessage } from "../../sessions/request-lifecycle/contracts.js";
import type { AgentMode } from "../../shared/types.js";
import type { RequestSessionStore } from "../request/session-store.js";

/** One non-durable terminal append. A rejected write has an uncertain outcome. */
export class TerminalResponseAppend {
  private attempted = false;
  private persisted = false;
  constructor(
    private readonly params: {
      store: Pick<RequestSessionStore, "appendMessage">;
      sessionId: string;
      requestId: string;
      agentMode: AgentMode;
    },
  ) {}

  snapshot(): Readonly<{ attempted: boolean; persisted: boolean }> {
    return Object.freeze({
      attempted: this.attempted,
      persisted: this.persisted,
    });
  }

  failureOutcome(
    error: unknown,
  ): "persisted" | "session_deleted" | "uncertain" {
    if (!this.attempted) return "uncertain";
    if (this.persisted) return "persisted";
    if (
      isSessionDeletedError(error) &&
      error.sessionId === this.params.sessionId
    )
      return "session_deleted";
    return "uncertain";
  }

  async append(message: SessionTerminalMessage): Promise<void> {
    if (this.attempted)
      throw new Error("terminal_response_append_already_attempted");
    this.attempted = true;
    const { content, ...metadata } = message;
    await this.params.store.appendMessage(
      this.params.sessionId,
      "assistant",
      content,
      {
        ...metadata,
        lastAgentMode: this.params.agentMode,
        requestId: this.params.requestId,
      },
    );
    this.persisted = true;
  }
}
