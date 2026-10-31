import { describe, expect, test, vi } from "vitest";
import { ChatGptAuthError, type ChatGptAttempt } from "../../provider-auth/chatgpt/contracts.js";
import type { ChatGptAuthService } from "../../provider-auth/chatgpt/service.js";
import { ChatGptWebAttemptOwner } from "./attempt-owner.js";

function fixture() {
  const attempts = new Map<string, ChatGptAttempt>();
  const service = {
    getAttempt: vi.fn((id: string) => {
      const attempt = attempts.get(id);
      if (!attempt) throw new ChatGptAuthError("chatgpt_attempt_not_found", "Absent", 404);
      return attempt;
    }),
    cancelAttempt: vi.fn((id: string) => {
      const attempt = attempts.get(id)!;
      attempt.status = "cancelled";
      return attempt;
    }),
  };
  const owner = new ChatGptWebAttemptOwner(service as unknown as ChatGptAuthService);
  const pending = (id: string): ChatGptAttempt => {
    const attempt: ChatGptAttempt = { attemptId: id, status: "pending", expiresAt: Date.now() + 60000 };
    attempts.set(id, attempt);
    return attempt;
  };
  return { owner, service, pending, attempts };
}

describe("ChatGPT Web listener attempt ownership", () => {
  test("closing cancels only this listener's attempts and fences new starts", async () => {
    const f = fixture();
    const external = f.pending("other-listener");
    await f.owner.start(async () => f.pending("owned"));
    f.owner.close();
    expect(f.service.cancelAttempt.mock.calls).toEqual([["owned"]]);
    expect(external.status).toBe("pending");
    const operation = vi.fn(async () => f.pending("late"));
    await expect(f.owner.start(operation)).rejects.toMatchObject({ code: "chatgpt_web_closed" });
    expect(operation).not.toHaveBeenCalled();
  });
  test("a start resolving after shutdown is cancelled before returning to the browser", async () => {
    const f = fixture();
    let resolve!: (attempt: ChatGptAttempt) => void;
    const started = f.owner.start(() => new Promise<ChatGptAttempt>((done) => { resolve = done; }));
    f.owner.close();
    resolve(f.pending("late"));
    await expect(started).rejects.toMatchObject({ code: "chatgpt_web_closed" });
    expect(f.service.cancelAttempt).toHaveBeenCalledWith("late");
  });
  test("settled and expired receipts are pruned before the next start", async () => {
    const f = fixture();
    const completed = await f.owner.start(async () => f.pending("completed"));
    completed.status = "complete";
    await f.owner.start(async () => f.pending("expired"));
    f.attempts.delete("expired");
    await f.owner.start(async () => f.pending("current"));
    f.owner.close();
    expect(f.service.cancelAttempt.mock.calls).toEqual([["current"]]);
  });
  test("shutdown preserves an account commit that has already started", async () => {
    const f = fixture();
    await f.owner.start(async () => f.pending("committing"));
    f.service.cancelAttempt.mockImplementation(() => { throw new ChatGptAuthError("chatgpt_attempt_completing", "Saving", 409); });
    expect(() => f.owner.close()).not.toThrow();
    expect(f.attempts.get("committing")?.status).toBe("pending");
  });
});
