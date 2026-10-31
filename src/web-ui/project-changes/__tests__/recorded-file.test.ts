import { describe, expect, it, vi } from "vitest";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { captureFileOutputRootId } from "../../../runtime/capabilities/file-output-root-identity.js";
import { ConversationFileAccess } from "../../local-runtime/conversation-file-access.js";
import type { LocalRequestExecution } from "../../local-runtime/request-execution.js";
import type { SessionRequestReplay } from "../../../sessions/types.js";
import { readRecordedProjectChange } from "../recorded-file.js";
import { projectChangesFixture } from "./fixture.js";

const reference = { environmentId: "dev", sessionId: "session-1", requestId: "request-1", executionId: "execution-1" };
async function setup(path = "file.txt") {
  const fixture = await projectChangesFixture();
  const rootId = captureFileOutputRootId("agent_work", fixture.root);
  const receipt = { version: 1, location: "agent_work", rootId, relativePath: path, logicalPath: path, operation: "updated" };
  const replay: SessionRequestReplay = { requestId: reference.requestId, sessionId: reference.sessionId, generation: "generation-1", finalState: null,
    events: [{ type: "event", name: "tool.completed", requestId: reference.requestId, executionId: reference.executionId, ok: true, meta: { fileOutput: receipt } }] };
  fixture.setReplay(replay);
  const access = new ConversationFileAccess(fixture.environments, { activeReplayForSession: () => [] } as unknown as LocalRequestExecution, () => "dev");
  const read = () => readRecordedProjectChange(fixture.environments, "dev", access, reference);
  return { ...fixture, replay, receipt, access, read };
}
describe("recorded file project changes", () => {
  it("returns exact file counts and current HEAD patch together, then unchanged and deleted states", async () => {
    const fixture = await setup();
    await fixture.write("file.txt", "base\n"); await fixture.commit();
    await fixture.write("file.txt", "current\n");
    const before = await fixture.hashes();
    const result = await fixture.read();
    expect(result).toMatchObject({ status: "available", base: "head", file: { path: "file.txt", additions: 1, deletions: 1 }, preview: { status: "text", patch: expect.stringContaining("-base\n+current\n") } });
    expect(await fixture.hashes()).toEqual(before);
    await fixture.write("file.txt", "base\n");
    expect(await fixture.read()).toMatchObject({ status: "unchanged", file: null, preview: null, base: "head", revision: expect.any(String) });
    await rm(join(fixture.root, "file.txt"));
    expect(await fixture.read()).toMatchObject({ status: "available", file: { path: "file.txt", status: "deleted", additions: 0, deletions: 1 }, preview: { patch: expect.stringContaining("-base") } });
  });
  it("requires a unique successful completion for the exact request and execution", async () => {
    const fixture = await setup(); await fixture.write("file.txt", "secret\n");
    fixture.setReplay({ ...fixture.replay, events: [{ ...fixture.replay.events[0], ok: false }] });
    expect((await fixture.read()).status).toBe("unavailable");
    fixture.setReplay({ ...fixture.replay, events: [fixture.replay.events[0]!, fixture.replay.events[0]!] });
    expect((await fixture.read()).status).toBe("unavailable");
    fixture.setReplay({ ...fixture.replay, requestId: "different" });
    expect((await fixture.read()).status).toBe("unavailable");
    fixture.setReplay({ ...fixture.replay, events: [{ ...fixture.replay.events[0], executionId: "different" }] });
    expect((await fixture.read()).status).toBe("unavailable");
  });
  it("rejects cleared history and generation replacement during the read", async () => {
    const fixture = await setup(); await fixture.write("file.txt", "content\n");
    fixture.setReplay(null);
    expect((await fixture.read()).status).toBe("unavailable");
    fixture.setReplay(fixture.replay);
    const authorize = fixture.access.authorize.bind(fixture.access);
    vi.spyOn(fixture.access, "authorize").mockImplementation(async (input) => {
      const authority = await authorize(input);
      return { ...authority, assertCurrent: async () => { fixture.setReplay({ ...fixture.replay, generation: "generation-2" }); await authority.assertCurrent(); } };
    });
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null });
  });
  it("does not confuse workspace output with a same-named project file", async () => {
    const fixture = await setup(); await fixture.write("file.txt", "project\n"); await fixture.write("workspace/file.txt", "workspace\n");
    const rootId = captureFileOutputRootId("workspace", join(fixture.root, "workspace"));
    fixture.setReplay({ ...fixture.replay, events: [{ ...fixture.replay.events[0], meta: { fileOutput: { ...fixture.receipt, location: "workspace", logicalPath: "workspace/file.txt", rootId } } }] });
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null });
  });
  it("rejects a replaced root instance or root marker and never recreates a missing marker", async () => {
    const fixture = await setup(); await fixture.write("file.txt", "first\n");
    await rm(join(fixture.root, ".abot-file-output-root"));
    expect((await fixture.read()).status).toBe("unavailable");
    expect((await fixture.service.list("dev", "session-1")).files.map((file) => file.path)).not.toContain(".abot-file-output-root");
    await rename(fixture.root, `${fixture.root}-original`); await mkdir(fixture.root);
    await fixture.git("init", "-b", "main"); await fixture.write("file.txt", "different project\n"); captureFileOutputRootId("agent_work", fixture.root);
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null });
  });
  it("rechecks the recorded root marker after the snapshot", async () => {
    const fixture = await setup(); await fixture.write("file.txt", "current\n");
    const authorize = fixture.access.authorize.bind(fixture.access);
    vi.spyOn(fixture.access, "authorize").mockImplementation(async (input) => {
      const authority = await authorize(input);
      return { ...authority, assertCurrent: async () => { await authority.assertCurrent(); await fixture.write(".abot-file-output-root", "invalid marker\n"); } };
    });
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null });
  });
  it("never discloses the internal root marker through a recorded file receipt", async () => {
    const fixture = await setup(".abot-file-output-root");
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null, revision: null });
  });
  it("never calls a target missing from a truncated list unchanged", async () => {
    const fixture = await setup("zz-target.txt");
    await Promise.all(Array.from({ length: 201 }, (_, index) => fixture.write(`file-${String(index).padStart(3, "0")}.txt`, "new\n")));
    await fixture.write("zz-target.txt", "target\n");
    expect(await fixture.read()).toMatchObject({ status: "unavailable", file: null, preview: null, base: "empty", message: expect.stringContaining("bounded changes list") });
  });
});
