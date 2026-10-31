import { expect, test } from "vitest";
import { SessionService } from "../../session-service.js";
import type { SessionCommitTerminalCommand } from "../contracts.js";
import { accepted, activationExpected, fixture } from "./support.js";

test.each([undefined, "blocked"] as const)(
  "terminal completion persists optional display disposition %s across reopen",
  async (disposition) => {
    const f = await fixture();
    const command: SessionCommitTerminalCommand = {
      expected: activationExpected(f.started.current),
      commandId: "complete",
      status: "completed",
      message: { content: "Terminal response." },
      ...(disposition ? { disposition } : {}),
    };
    const committed = accepted(
      await f.service.requestLifecycle.commitTerminal("conversation", command),
    );
    expect(committed.current.status).toBe("completed");
    const duplicate = accepted(
      await f.service.requestLifecycle.commitTerminal("conversation", command),
    );
    expect(duplicate.duplicate).toBe(true);
    const reopened = new SessionService({ sessionsDir: f.directory });
    const replay = await reopened.getRequestReplayById("request");
    const events = replay!.events.filter((event) => event.type === "completed");
    expect(events).toHaveLength(1);
    for (const value of [committed.events.at(-1), events[0], replay!.finalState]) {
      if (disposition) expect(value).toHaveProperty("disposition", disposition);
      else expect(value).not.toHaveProperty("disposition");
    }
    expect(replay!.finalState).toMatchObject({
      status: "completed",
      output: "Terminal response.",
    });
  },
);

test.each([
  { status: "completed", disposition: "responded" },
  { status: "completed", disposition: null },
  { status: "failed", disposition: "blocked" },
])("rejects invalid terminal display metadata %j without mutation", async (input) => {
  const f = await fixture();
  const command = {
    expected: activationExpected(f.started.current),
    commandId: "invalid",
    message: { content: "Must not persist." },
    ...input,
  } as SessionCommitTerminalCommand;
  expect(
    await f.service.requestLifecycle.commitTerminal("conversation", command),
  ).toMatchObject({
    accepted: false,
    reason: "invalid_command",
  });
  expect(
    await f.service.requestLifecycle.get("conversation", "request"),
  ).toEqual(f.started.current);
  const replay = await f.service.getRequestReplayById("request");
  expect(replay!.finalState).toBeNull();
  expect(
    (await f.service.getSessionById("conversation"))!.messages,
  ).toHaveLength(1);
});
