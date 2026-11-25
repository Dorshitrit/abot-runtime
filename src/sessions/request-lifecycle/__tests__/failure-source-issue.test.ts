import { expect, test, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService } from "../../session-service.js";
import type { SessionCommitTerminalCommand } from "../contracts.js";
import { accepted, activationExpected } from "./support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "model-issue-terminal-"));
  directories.push(directory);
  const service = new SessionService({ sessionsDir: directory });
  await service.appendMessage("conversation", "user", "Do the fixture task.", { requestId: "request" });
  const started = accepted(await service.requestLifecycle.startActivation("conversation", {
    requestId: "request", activationId: "activation", ownerEpoch: "owner",
  }));
  return { directory, service, started };
}

test.each([undefined, "exact-source-occurrence"])("terminal failure preserves only explicit causal identity %s across reopen", async (sourceIssueId) => {
  const f = await fixture();
  const command: SessionCommitTerminalCommand = {
    expected: activationExpected(f.started.current), commandId: "failed", status: "failed",
    error: "fixture_failure", message: { content: "Stopped safely." },
    ...(sourceIssueId ? { sourceIssueId } : {}),
  };
  const committed = accepted(await f.service.requestLifecycle.commitTerminal("conversation", command));
  const duplicate = accepted(await f.service.requestLifecycle.commitTerminal("conversation", command));
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.events).toEqual([]);
  const reopened = new SessionService({ sessionsDir: f.directory });
  const replay = await reopened.getRequestReplayById("request");
  const failed = replay!.events.filter((event) => event.type === "failed");
  expect(failed).toHaveLength(1);
  for (const event of [committed.events.at(-1), failed[0]]) {
    expect(event?.details).toEqual({ stoppedResponse: "Stopped safely.", ...(sourceIssueId ? { sourceIssueId } : {}) });
  }
});

test.each(["private message with spaces", "x".repeat(65)])("terminal cause rejects unbounded identity %s without writes", async (sourceIssueId) => {
  const f = await fixture();
  expect(await f.service.requestLifecycle.commitTerminal("conversation", {
    expected: activationExpected(f.started.current), commandId: "invalid", status: "failed",
    message: { content: "Must not persist." }, sourceIssueId,
  })).toMatchObject({ accepted: false, reason: "invalid_command" });
  expect(await f.service.requestLifecycle.get("conversation", "request")).toEqual(f.started.current);
});
