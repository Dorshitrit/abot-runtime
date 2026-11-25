import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as atomicWrite from "../../../plugins/filesystem/source/atomic-write.js";
import * as snapshot from "../../../plugins/filesystem-ea/source/snapshot.js";
import { FilesystemToolError } from "../../../plugins/filesystem/source/errors.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });
async function setup() {
  const fixture = await eaFixture(); fixtures.push(fixture);
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, "old\r\n");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  return { fixture, request, file, read };
}

test("committed references survive approval restore without reauthoring and reject drift", async () => {
  const { fixture, request, file, read } = await setup();
  const first = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "first\r\n");
  const firstResult = await first.prepared.execute();
  if (firstResult.status !== "executed") throw new Error("expected_execution");
  const controls = { path: "text.txt", range_ref: firstResult.result.data?.range_ref };
  const pending = await fixture.request({ state: request.state.snapshot(), permission: "ask" });
  const next = await pending.prepareBody("edit_text", controls, "approved\r\n");
  expect(next.source.context.sourceText).toBe("first\r\n");
  const saved = pending.state.snapshot();
  const restored = await fixture.request({ state: saved, permission: "ask" });
  const resume = await restored.executor.restore(next.prepared.snapshot);
  if (resume.status !== "prepared") throw new Error("expected_prepared");
  resume.applyApprovalDecision({ approvalId: resume.approvalRequest!.approvalId,
    actionFingerprint: resume.actionFingerprint, decision: { approved: true } });
  expect(await resume.execute()).toMatchObject({ result: { ok: true, data: { range_ref: expect.any(String) } } });
  expect(await readFile(file, "utf8")).toBe("approved\r\n");
  const stale = await fixture.request({ state: saved, permission: "ask" });
  await expect(stale.executor.restore(next.prepared.snapshot)).rejects.toThrow("registered_tool_snapshot_incompatible");
});

test("legacy text-bearing state still restores; malformed lightweight state fails closed", async () => {
  const { fixture, request, read } = await setup();
  const legacy = JSON.parse(JSON.stringify(request.state.snapshot()));
  legacy["filesystem-ea.v1"].version = 1;
  const old = await fixture.request({ state: legacy });
  const prepared = await old.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "new");
  expect(prepared.source.context.sourceText).toBe("old\r\n");
  const execution = await prepared.prepared.execute();
  if (execution.status !== "executed") throw new Error("expected_execution");
  const state = JSON.parse(JSON.stringify(old.state.snapshot()));
  const variants = [
    { origin: "unknown" }, { text: "new" }, { start: -1 }, { end: 1_048_577 }, { end: 262_145 },
  ];
  for (const change of variants) {
    const invalid = structuredClone(state);
    const range = invalid["filesystem-ea.v1"].ranges.find((value: { origin?: string }) => value.origin === "committed_edit");
    Object.assign(range, change);
    await expect(fixture.request({ state: invalid })).rejects.toMatchObject({ code: "ea_request_state_invalid" });
  }
  state["filesystem-ea.v1"].version = 1;
  await expect(fixture.request({ state })).rejects.toMatchObject({ code: "ea_request_state_invalid" });
});

test.each(["budget", "write_abort"])("%s before commit preserves every previous range at full capacity", async (failure) => {
  const { request, file } = await setup();
  const references: unknown[] = [];
  for (let index = 0; index < 32; index++) {
    const result = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
    references.push(result.data?.range_ref);
  }
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: references.at(-1) }, "new");
  const before = request.state.snapshot();
  if (failure === "budget") {
    const execute = request.port.execute;
    request.port.execute = (call, options) => execute(call, { ...options, resultBudget: {
      assess(result) {
        const bytes = Buffer.byteLength(JSON.stringify(result));
        return { fits: result.data?.range_ref === undefined, serializedBytes: bytes, maxBytes: 262_144 };
      },
    } });
  } else {
    vi.spyOn(atomicWrite, "atomicWriteText").mockRejectedValue(new FilesystemToolError("filesystem_target_changed", "Aborted before write."));
  }
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: false } });
  expect(request.state.snapshot()).toEqual(before);
  expect(await readFile(file, "utf8")).toBe("old\r\n");
  for (const range_ref of [references[0], references.at(-1)]) {
    const next = await request.prepareBody("edit_text", { path: "text.txt", range_ref }, "still usable");
    expect(next.source.context.sourceText).toBe("old\r\n");
  }
});

test("restored committed offsets cannot split a character or expand beyond the authored byte limit", async () => {
  const { fixture, request, file, read } = await setup();
  const first = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "🙂");
  const execution = await first.prepared.execute();
  if (execution.status !== "executed") throw new Error("expected_execution");
  const controls = { path: "text.txt", range_ref: execution.result.data?.range_ref };
  const state = JSON.parse(JSON.stringify(request.state.snapshot()));
  const range = state["filesystem-ea.v1"].ranges.find((entry: { id: unknown }) => entry.id === controls.range_ref);
  range.start = 1; range.end = 1;
  const split = await fixture.request({ state });
  await expect(split.prepareBody("edit_text", controls, "bad")).rejects.toMatchObject({ code: "ea_range_invalid" });
  const body = "🙂".repeat(70_000);
  await writeFile(file, body);
  const current = await snapshot.readSnapshot(fixture.resolver.resolve("text.txt"));
  range.start = 0; range.end = body.length; range.version = snapshot.versionKey(current.version);
  const expanded = await fixture.request({ state });
  await expect(expanded.prepareBody("edit_text", controls, "bad")).rejects.toMatchObject({ code: "ea_range_invalid" });
  expect(await readFile(file, "utf8")).toBe(body);
});

test.each(["external_change", "snapshot_error"])("%s after commit preserves successful mutation evidence and explains missing ref", async (failure) => {
  const { request, file, read } = await setup();
  const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "committed");
  const write = atomicWrite.atomicWriteText;
  const readSnapshot = snapshot.readSnapshot;
  let committed = false;
  vi.spyOn(atomicWrite, "atomicWriteText").mockImplementation(async (input) => {
    await write(input); committed = true;
    if (failure === "external_change") await writeFile(file, "external");
  });
  vi.spyOn(snapshot, "readSnapshot").mockImplementation((target) => {
    if (committed && failure === "snapshot_error") throw new Error("snapshot unavailable");
    return readSnapshot(target);
  });
  const execution = await edit.prepared.execute();
  expect(execution).toMatchObject({ result: { ok: true, data: { mutationEvidence: true, range_ref_unavailable: expect.any(String) } } });
  if (execution.status !== "executed") throw new Error("expected_execution");
  expect(execution.result.data?.range_ref).toBeUndefined();
  expect(execution.result.output).toContain("The edit completed");
  expect(execution.result.output).toContain("Read the desired range again");
  expect(execution.result.data?.mutationGrounding).toContain("committed");
  expect(await readFile(file, "utf8")).toBe(failure === "external_change" ? "external" : "committed");
  const state = JSON.parse(JSON.stringify(request.state.snapshot()));
  expect(state["filesystem-ea.v1"].bindings).toEqual([]);
  expect(state["filesystem-ea.v1"].ranges).toHaveLength(1);
});

test("successful edits recycle bounded reference slots without storing replacement bodies", async () => {
  const { request, file, read } = await setup();
  let range_ref = read.data?.range_ref;
  for (let index = 0; index < 40; index++) {
    const edit = await request.prepareBody("edit_text", { path: "text.txt", range_ref }, `version ${index}`);
    const execution = await edit.prepared.execute();
    if (execution.status !== "executed") throw new Error("expected_execution");
    expect(execution.result.ok).toBe(true);
    range_ref = execution.result.data?.range_ref;
    expect(range_ref).toEqual(expect.any(String));
  }
  const state = JSON.parse(JSON.stringify(request.state.snapshot()));
  expect(state["filesystem-ea.v1"].ranges).toHaveLength(32);
  expect(state["filesystem-ea.v1"].bindings).toHaveLength(0);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(1_048_576);
  const final = await request.prepareBody("edit_text", { path: "text.txt", range_ref }, "done");
  expect(final.source.context.sourceText).toBe("version 39");
  expect(await readFile(file, "utf8")).toBe("version 39");
});
