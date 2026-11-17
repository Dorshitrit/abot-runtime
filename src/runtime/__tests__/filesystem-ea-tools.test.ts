import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
import { getProcessFilesystemMutationCoordinator } from "../../../plugins/filesystem/source/mutation-coordinator.js";
import * as windowsProcess from "../../../plugins/filesystem/source/windows/process.js";
import { createToolRegistry } from "../../capabilities/registry.js";
import { prepareRequestToolModules } from "../capabilities/request-module-preparation.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";
import { RequestToolState } from "../capabilities/request-tool-state.js";
import { createRangeReferences } from "../../../plugins/filesystem-ea/source/range-references.js";
import { digest } from "../../../plugins/filesystem-ea/source/snapshot.js";

const fixtures: Awaited<ReturnType<typeof eaFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())); });
async function setup() { const fixture = await eaFixture(); fixtures.push(fixture); return fixture; }

test("installed defaults prepare EA file tools without a separate enable switch", async () => {
  const fixture = await setup();
  const prepared = await prepareRequestToolModules(fixture.modules, {
    requestId: "default-ea-request", rootContractId: "execution_agent", runtimePathResolver: fixture.resolver,
  });
  expect(prepared.map((entry) => entry.definition.name).sort()).toEqual(["create_text", "edit_text", "read_text"]);
});

test.each([false, true])("SUPER catalog and contracts stay identical with EA enabled=%s", async (enabled) => {
  const fixture = await setup();
  const superRequest = await fixture.request({ enabled, rootContractId: "supervisor" });
  expect(superRequest.executor.operations).toEqual([]);
  expect(await superRequest.port.execute({ tool: "edit_text", params: { path: "a" } })).toMatchObject({ ok: false });
  const before = createToolRegistry({ modules: fixture.legacy }).getNormalInvocations();
  const prepared = await prepareRequestToolModules([...fixture.legacy, ...fixture.modules], {
    rootContractId: "supervisor", runtimePathResolver: fixture.resolver,
  });
  expect(createToolRegistry({ modules: prepared }).getNormalInvocations()).toEqual(before);
});

test("explicit disable, missing owner, base handler, and missing restored owner fail closed", async () => {
  const fixture = await setup();
  expect((await fixture.request({ enabled: false })).executor.operations).toEqual([]);
  expect((await fixture.request({ rootContractId: undefined })).executor.operations).toEqual([]);
  expect(await prepareRequestToolModules(fixture.modules, { rootContractId: "execution_agent", runtimePathResolver: fixture.resolver })).toEqual([]);
  expect(await fixture.modules[0]!.implementation({ path: "test.txt" })).toMatchObject({ ok: false });
  const request = await fixture.request();
  await expect(fixture.request({ enabled: false, state: request.state.snapshot() })).rejects.toThrow("tool_request_state_owner_unavailable");
  await expect(fixture.request({ requestId: "other-request", state: request.state.snapshot() })).rejects.toMatchObject({ code: "ea_request_state_invalid" });
});

test.each(["\uFEFFשלום\r\nsecond\r\n", "hello without final newline", "", "\n"])(
  "read and range replacement preserve exact source bytes: %j", async (original) => {
    const fixture = await setup();
    const file = join(fixture.paths.agentWorkDir, "text.txt");
    await writeFile(file, original);
    const request = await fixture.request();
    const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
    expect(read.ok).toBe(true);
    expect(read.output.split("Content:\n")[1]).toBe(original);
    const range_ref = read.data?.range_ref;
    expect(range_ref).toEqual(expect.any(String));
    const { prepared, source } = await request.prepareBody("edit_text", { path: "text.txt", range_ref }, "  replacement\r\n");
    expect(source.context.sourceText).toBe(original);
    expect(await prepared.execute("change-1")).toMatchObject({ status: "executed", result: { ok: true } });
    expect(await readFile(file, "utf8")).toBe("  replacement\r\n");
    expect(JSON.stringify(request.events)).not.toContain(String(range_ref));
  });

test("bounded window and locator declare coverage; truncated output has no reusable reference", async () => {
  const fixture = await setup();
  const request = await fixture.request();
  await writeFile(join(fixture.paths.agentWorkDir, "text.txt"), "a\r\nb\r\nc\r\n");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt", start_line: 2, end_line: 2 } });
  expect(read.output).toContain("Coverage: complete requested window");
  expect(read.output.split("Content:\n")[1]).toBe("b\r\n");
  const found = await request.port.execute({ tool: "read_text", params: { path: "text.txt", locator: "b", context_lines: 1 } });
  expect(found.ok).toBe(true);
  await writeFile(join(fixture.paths.agentWorkDir, "large.txt"), "🙂".repeat(9000));
  const truncated = await request.port.execute({ tool: "read_text", params: { path: "large.txt" } });
  expect(truncated.output).toContain("Coverage: truncated window");
  expect(truncated.data?.range_ref).toBeUndefined();
  expect(truncated.output).not.toContain("�");
  expect(truncated.data?.eventMeta?.truncated).toBe(true);
});

test("create-only, empty file, missing parents, and plain range edits are deterministic", async () => {
  const fixture = await setup();
  const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "new", "text.txt");
  const create = await request.prepareBody("create_text", { path: "new/text.txt" }, "");
  expect(await create.prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe("");
  await expect(request.prepareBody("create_text", { path: "new/text.txt" }, "overwrite")).rejects.toMatchObject({ code: "ea_file_exists" });
  await writeFile(file, '\uFEFFconst a = "{";\r\nconst b = 2;');
  const read = await request.port.execute({ tool: "read_text", params: { path: "new/text.txt" } });
  const edit = await request.prepareBody("edit_text", { path: "new/text.txt", range_ref: read.data?.range_ref },
    '\uFEFFlet a = "{";\r\nconst b = 3;');
  expect(edit.source.responseFormat).toBeUndefined();
  expect(await edit.prepared.execute()).toMatchObject({ result: { ok: true, data: { eventMeta: { changedChunkCount: 1 } } } });
  expect(await readFile(file, "utf8")).toBe('\uFEFFlet a = "{";\r\nconst b = 3;');
});

test("default reading selects the first 120 lines of a longer file", async () => {
  const fixture = await setup(); const request = await fixture.request();
  const content = Array.from({ length: 700 }, (_, index) => `row ${index}\n`).join("");
  await writeFile(join(fixture.paths.agentWorkDir, "many-lines.txt"), content);
  const result = await request.port.execute({ tool: "read_text", params: { path: "many-lines.txt" } });
  expect(result.output.split("Content:\n")[1]).toBe(content.split("\n").slice(0, 120).join("\n") + "\n");
  expect(result.data?.eventMeta).toMatchObject({ startLine: 1, endLine: 120, complete: false, truncated: false });
  expect(result.data?.range_ref).toEqual(expect.any(String));
});

test.each([
  { size: "small", padding: "" },
  { size: "over 24 KB", padding: "x".repeat(24_001) },
])("range authoring supplies only the selected window for a $size target", async ({ padding }) => {
  const fixture = await setup(); const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "code.ts");
  const content = `first = 1;\n${padding}\nthird = 3;\n`;
  await writeFile(file, content);
  const selected = await request.port.execute({ tool: "read_text", params: { path: "code.ts", start_line: 3, end_line: 3 } });
  const { source, prepared } = await request.prepareBody("edit_text",
    { path: "code.ts", range_ref: selected.data?.range_ref }, "third = 5;\n");
  expect(source.context).toEqual({ path: "code.ts", mode: "range", sourceText: "third = 3;\n", maxBytes: 262_144 });
  expect(source.responseFormat).toBeUndefined();
  expect(await prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe(content.replace("third = 3", "third = 5"));
});

test("an explicitly selected range is preserved independently of the last read", async () => {
  const fixture = await setup(); const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "large.txt");
  const content = "selected\n" + "x".repeat(24_000) + "\nlast\n";
  await writeFile(file, content);
  const selected = await request.port.execute({ tool: "read_text", params: { path: "large.txt", start_line: 1, end_line: 1 } });
  await request.port.execute({ tool: "read_text", params: { path: "large.txt", start_line: 3, end_line: 3 } });
  const { source, prepared } = await request.prepareBody("edit_text",
    { path: "large.txt", range_ref: selected.data?.range_ref }, "replacement\n");
  expect(source.context).toMatchObject({ mode: "range", sourceText: "selected\n" });
  expect(await prepared.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe(content.replace("selected\n", "replacement\n"));
});

test("empty files can be filled, cleared and refilled through fresh range reads", async () => {
  const fixture = await setup(); const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "empty.txt");
  await writeFile(file, "");
  for (const [before, replacement] of [["", "first"], ["first", ""], ["", "second"], ["second", "second"]]) {
    const read = await request.port.execute({ tool: "read_text", params: { path: "empty.txt" } });
    const { source, prepared } = await request.prepareBody("edit_text", { path: "empty.txt", range_ref: read.data?.range_ref }, replacement);
    expect(source.context).toEqual({ path: "empty.txt", mode: "range", sourceText: before, maxBytes: 262_144 });
    const result = await prepared.execute();
    expect(result).toMatchObject({ result: { ok: true, data: { mutationEvidence: before !== replacement } } });
    expect(await readFile(file, "utf8")).toBe(replacement);
  }
});

test.each([undefined, null, "", "range:missing"])("missing or unknown selected range fails before authoring: %j", async (range_ref) => {
  const fixture = await setup(); const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "text.txt");
  await writeFile(file, "abc a");
  await expect(request.prepareBody("edit_text", { path: "text.txt", range_ref }, "replacement")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("abc a");
});

test("range and prepared source cannot be reused across requests or silently refreshed", async () => {
  const fixture = await setup(); const request = await fixture.request();
  const file = join(fixture.paths.agentWorkDir, "text.txt"); await writeFile(file, "old\n");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const controls = { path: "text.txt", range_ref: read.data?.range_ref };
  await writeFile(join(fixture.paths.agentWorkDir, "other.txt"), "other");
  await expect(request.prepareBody("edit_text", { path: "other.txt", range_ref: controls.range_ref }, "new\n"))
    .rejects.toMatchObject({ code: "ea_range_invalid" });
  const fresh = await fixture.request();
  await expect(fresh.prepareBody("edit_text", controls, "new\n")).rejects.toMatchObject({ code: "ea_range_invalid" });
  const { prepared } = await request.prepareBody("edit_text", controls, "new\n");
  await writeFile(file, "external change\n");
  expect(await prepared.execute()).toMatchObject({ result: { ok: false, errorCode: "filesystem_target_changed" } });
  await expect(request.prepareBody("edit_text", controls, "new\n")).rejects.toMatchObject({ code: "filesystem_target_changed" });
  expect(await readFile(file, "utf8")).toBe("external change\n");
});

test("approval restoration uses the original prepared bytes and refuses a changed source", async () => {
  const fixture = await setup(); const request = await fixture.request({ permission: "ask" });
  const file = join(fixture.paths.agentWorkDir, "text.txt"); await writeFile(file, "old");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const { prepared } = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "new");
  expect(prepared.approvalRequest).toBeDefined();
  expect(await readFile(file, "utf8")).toBe("old");
  const restored = await fixture.request({ state: request.state.snapshot(), permission: "ask" });
  const resumed = await restored.executor.restore(prepared.snapshot);
  expect(resumed.status).toBe("prepared");
  if (resumed.status === "prepared") {
    expect(resumed.actionFingerprint).toBe(prepared.actionFingerprint);
    resumed.applyApprovalDecision({ approvalId: resumed.approvalRequest!.approvalId,
      actionFingerprint: resumed.actionFingerprint, decision: { approved: true } });
    expect(await resumed.execute()).toMatchObject({ result: { ok: true } });
  }
  expect(await readFile(file, "utf8")).toBe("new");
  const stale = await fixture.request({ state: request.state.snapshot(), permission: "ask" });
  await expect(stale.executor.restore(prepared.snapshot)).rejects.toThrow("registered_tool_snapshot_incompatible");
});

test("legacy exact bindings cannot execute or block a separate restored range approval", async () => {
  const fixture = await setup(); const request = await fixture.request({ permission: "ask" });
  const file = join(fixture.paths.agentWorkDir, "text.txt"); await writeFile(file, "old\n");
  const read = await request.port.execute({ tool: "read_text", params: { path: "text.txt" } });
  const { prepared } = await request.prepareBody("edit_text", { path: "text.txt", range_ref: read.data?.range_ref }, "approved\n");
  const state = JSON.parse(JSON.stringify(request.state.snapshot())) as Record<string, { bindings: Record<string, unknown>[] }>;
  const bindings = state["filesystem-ea.v1"]!.bindings;
  bindings.push({ ...bindings[0], id: "legacy-exact", mode: "exact", bodyDigest: digest("legacy-body") });
  const restored = await fixture.request({ state, permission: "ask" });
  const legacyCall = { tool: "edit_text", params: { path: "text.txt",
    payload: JSON.stringify({ binding: "legacy-exact", body: "legacy-body" }) } };
  expect(await restored.port.execute(legacyCall)).toMatchObject({ ok: false, errorCode: "ea_payload_binding_invalid" });
  await expect(restored.executor.restore({ ...(prepared.snapshot as Record<string, unknown>),
    call: legacyCall, acceptedControls: { path: "text.txt" } }))
    .rejects.toThrow("registered_tool_snapshot_incompatible");
  expect(await readFile(file, "utf8")).toBe("old\n");
  const resumed = await restored.executor.restore(prepared.snapshot);
  if (resumed.status !== "prepared") throw new Error("expected_prepared");
  resumed.applyApprovalDecision({ approvalId: resumed.approvalRequest!.approvalId,
    actionFingerprint: resumed.actionFingerprint, decision: { approved: true } });
  expect(await resumed.execute()).toMatchObject({ result: { ok: true } });
  expect(await readFile(file, "utf8")).toBe("approved\n");
});

test("root containment, symlinks, binary files, and oversized files fail without mutation", async () => {
  const fixture = await setup(); const request = await fixture.request();
  await writeFile(join(fixture.root, "outside.txt"), "outside");
  await symlink(join(fixture.root, "outside.txt"), join(fixture.paths.agentWorkDir, "link.txt"));
  await writeFile(join(fixture.paths.agentWorkDir, "binary.txt"), Buffer.from([0, 1, 2]));
  await writeFile(join(fixture.paths.agentWorkDir, "huge.txt"), "x".repeat(1_048_577));
  for (const path of ["../outside.txt", "link.txt", "binary.txt", "huge.txt"]) {
    expect(await request.port.execute({ tool: "read_text", params: { path } })).toMatchObject({ ok: false });
  }
  expect(await readFile(join(fixture.root, "outside.txt"), "utf8")).toBe("outside");
});

test("selected edit range survives request state restore with exact text", async () => {
  const fixture = await setup(); const request = await fixture.request();
  await writeFile(join(fixture.paths.agentWorkDir, "types.ts"), "export type X = { a: string };\r\n");
  const read = await request.port.execute({ tool: "read_text", params: { path: "types.ts" } });
  const restored = await fixture.request({ state: request.state.snapshot() });
  const result = await restored.prepareBody("edit_text", { path: "types.ts", range_ref: read.data?.range_ref }, "export {};\n");
  expect(result.source.context.sourceText).toBe("export type X = { a: string };\r\n");
  expect(await result.prepared.execute()).toMatchObject({ result: { ok: true } });
});

test.each(["\uFEFFexact\r\ncontent", "🙂".repeat(20_000)])("write evidence declares full or bounded coverage without expanding events", async (body) => {
  const fixture = await setup(); const request = await fixture.request();
  const { prepared } = await request.prepareBody("create_text", { path: "new.txt" }, body);
  const execution = await prepared.execute();
  expect(execution.status).toBe("executed");
  if (execution.status !== "executed") throw new Error("expected_execution");
  const data = execution.result.data!;
  const truncated = body.length > 30_000;
  expect(data.truncation).toEqual({ groundingTruncated: truncated, groundingCoverage: truncated ? "head_tail" : "full" });
  expect(String(data.mutationGrounding).length).toBeLessThanOrEqual(32_768);
  expect(data.mutationGrounding).not.toContain("�");
  expect(data.mutationGrounding).toContain("validation=not_applicable; structural_integrity=unknown");
  if (truncated) expect(data.mutationGrounding).toContain("OMITTED chars");
  if (!truncated) expect(data.mutationGrounding).toContain(body);
  expect(JSON.stringify(request.events)).not.toContain("mutationGrounding");
  expect(String(data.eventMeta?.outputPreview).length).toBeLessThanOrEqual(1200);
  expect(await readFile(join(fixture.paths.agentWorkDir, "new.txt"), "utf8")).toBe(body);
});

test("request state stays bounded with pending bindings and evicts old windows", () => {
  const state = new RequestToolState();
  const refs = createRangeReferences({ requestId: "bounded-request", requestState: state.port });
  const ids: string[] = [];
  for (let index = 0; index < 128; index++) {
    try { ids.push(refs.bind({ path: "p".repeat(8192), version: "v".repeat(8192), mode: "create" }).id); }
    catch (error) { expect(error).toMatchObject({ code: "ea_request_state_limit" }); break; }
  }
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.length).toBeLessThan(128);
  for (const id of ids) refs.seal(id, "a".repeat(64));
  expect(Buffer.byteLength(JSON.stringify(state.snapshot()))).toBeLessThan(1_048_576);
  for (const id of ids) refs.forget(id);
  const observe = () => refs.observe({ path: "p", targetPath: "p", version: "v", start: 0, end: 1, text: "a" });
  const first = observe();
  for (let index = 0; index < 32; index++) observe();
  expect(() => refs.resolve(first, "p", "v")).toThrow();
});

test("Windows preparation probes once and hides unavailable helpers", async () => {
  const fixture = await setup();
  const probe = vi.spyOn(windowsProcess, "runWindowsFilesystem").mockResolvedValue({ available: false });
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { expect((await fixture.request()).executor.operations).toEqual([]); }
  finally { Object.defineProperty(process, "platform", { value: platform }); }
  expect(probe).toHaveBeenCalledExactlyOnceWith({ operation: "probe" });
});

test("separately bundled filesystem plugins share the same mutation queue", async () => {
  const fixture = await setup();
  const key = Symbol.for("abot.filesystem.mutation-coordinator.v1");
  const globalQueue = Reflect.get(globalThis, key);
  expect(globalQueue).toBeDefined();
  const create = createRequire(import.meta.url)(join(process.cwd(), "plugins/filesystem-ea/src/index.cjs")).default;
  const plugin = create({ config: { enabled: true } });
  await plugin.prepareRequest(fixture.modules, {
    requestId: "bundled-request", rootContractId: "execution_agent", runtimePathResolver: fixture.resolver,
  });
  expect(Reflect.get(globalThis, key)).toBe(globalQueue);
  expect(getProcessFilesystemMutationCoordinator()).toBe(globalQueue);
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = globalQueue.runExclusive("same-target", async () => {
    order.push("first"); await blocked; order.push("finished");
  });
  const second = getProcessFilesystemMutationCoordinator().runExclusive("same-target", async () => {
    order.push("second");
  });
  await Promise.resolve();
  expect(order).toEqual(["first"]);
  release(); await Promise.all([first, second]);
  expect(order).toEqual(["first", "finished", "second"]);
});
