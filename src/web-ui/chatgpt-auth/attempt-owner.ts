import { ChatGptAuthError, type ChatGptAttempt } from "../../provider-auth/chatgpt/contracts.js";
import type { ChatGptAuthService } from "../../provider-auth/chatgpt/service.js";

/** Fence only attempts started by this Web UI; the host auth service is shared. */
export class ChatGptWebAttemptOwner {
  private closed = false;
  private readonly pending = new Set<string>();
  constructor(private readonly service: ChatGptAuthService) {}

  private requireOpen(): void {
    if (this.closed)
      throw new ChatGptAuthError("chatgpt_web_closed", "This ABot sign-in window is closing.", 503);
  }
  private pruneSettled(): void {
    for (const id of this.pending) {
      try {
        if (this.service.getAttempt(id).status !== "pending") this.pending.delete(id);
      } catch (error) {
        if (!(error instanceof ChatGptAuthError) || error.code !== "chatgpt_attempt_not_found") throw error;
        this.pending.delete(id);
      }
    }
  }
  private cancelOwned(id: string): void {
    try { this.service.cancelAttempt(id); }
    catch (error) {
      if (!(error instanceof ChatGptAuthError)) throw error;
      if (error.code === "chatgpt_attempt_not_found") return;
      // A commit already in progress keeps the existing durable-save contract.
      if (error.code === "chatgpt_attempt_completing") return;
      throw error;
    }
  }
  async start(operation: () => Promise<ChatGptAttempt>): Promise<ChatGptAttempt> {
    this.requireOpen();
    this.pruneSettled();
    const attempt = await operation();
    if (this.closed) {
      this.cancelOwned(attempt.attemptId);
      this.requireOpen();
    }
    if (attempt.status === "pending") this.pending.add(attempt.attemptId);
    return attempt;
  }
  close(): void {
    this.closed = true;
    for (const id of this.pending) this.cancelOwned(id);
    this.pending.clear();
  }
}
