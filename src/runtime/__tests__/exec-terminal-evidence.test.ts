import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureExecFilesystemSnapshot } from "../../../plugins/exec/source/filesystem-observer.js";
import { finalizeExecResult } from "../../../plugins/exec/source/result-presentation.js";
import type {
  ExecProcessSnapshot,
  ExecStreamSnapshot,
  PendingExecExecution,
} from "../../../plugins/exec/source/types.js";
import {
  createExecOutputFixture,
  disposeExecOutputFixtures,
  readSingleOutputOwner,
} from "./support/exec-output-fixture.js";

afterEach(disposeExecOutputFixtures);

function emptyTerminalStream(): ExecStreamSnapshot {
  return {
    text: "",
    sawOutput: false,
    metadata: {
      truncated: false,
      originalChars: 0,
      returnedChars: 0,
      omittedChars: 0,
    },
  };
}

async function createTerminalEvidenceFixture() {
  const fixture = await createExecOutputFixture();
  const root = fixture.config.paths.agentWorkDir;
  const execution: PendingExecExecution = {
    commandPreview: "terminal evidence fixture",
    cwd: { absolutePath: root, logicalPath: "." },
    filesystemStateBefore: await captureExecFilesystemSnapshot(root, "."),
    hardTimeoutMs: 5000,
    idleTimeoutMs: 5000,
  };
  const snapshot: ExecProcessSnapshot = {
    processId: "terminal-evidence-process",
    status: "settled",
    exitCode: 1,
    terminationReason: "completed",
    elapsedMs: 1,
    stdout: emptyTerminalStream(),
    stderr: emptyTerminalStream(),
  };
  return { root, execution, snapshot };
}

test("a nonzero exit preserves written files, exact streams and observed effects in both result views", async () => {
  const fixture = await createExecOutputFixture();
  const request = fixture.createRequest();
  const params = {
    cwd: ".",
    command: `node -e "require('node:fs').writeFileSync('changed.txt','saved'); process.stdout.write('retained stdout\\n'); process.stderr.write('retained stderr\\n'); process.exitCode=1"`,
  };
  const result = await request.handlers.exec(params, request.admittedContext("exec", params));

  expect(result).toMatchObject({
    ok: false,
    exitCode: 1,
    errorCode: "non_zero_exit",
    stdout: "retained stdout\n",
    stderr: "retained stderr\n",
    data: { mutationEvidence: true, filesystemObservation: { complete: true } },
  });
  expect(result.contextTextFields).toBeUndefined();
  expect(result.actions).toContainEqual(expect.objectContaining({ target: "changed.txt" }));
  expect(result.output).toContain("Filesystem changes observed: 1 under CWD (.)");
  expect(result.output).toContain("- write_file: changed.txt (created)");
  expect(result.error).toContain("The command exited with code 1.");
  expect(result.error).toContain("Filesystem changes observed: 1 under CWD (.)");
  expect(result.error).toContain("does not establish that earlier effects were undone");
  expect(result.output).not.toContain("retained stdout\n");
  await expect(readFile(join(fixture.config.paths.agentWorkDir, "changed.txt"), "utf8"))
    .resolves.toBe("saved");

  const { directory } = await readSingleOutputOwner(fixture.context.stateDir);
  const streams = await Promise.all((await readdir(directory))
    .filter((name) => name.endsWith(".bytes"))
    .map((name) => readFile(join(directory, name), "utf8")));
  expect(streams).toHaveLength(2);
  expect(streams).toEqual(expect.arrayContaining(["retained stdout\n", "retained stderr\n"]));
});

test("exec_wait reports settled failure and effects without replaying the command or losing earlier output", async () => {
  const fixture = await createExecOutputFixture({ yieldAfterMs: 20 });
  const request = fixture.createRequest();
  const params = {
    cwd: ".",
    command: `node -e "require('node:fs').appendFileSync('executed-once.txt','x'); process.stdout.write('started\\n'); setTimeout(()=>{process.stderr.write('failed later\\n'); process.exitCode=1},300)"`,
  };
  let result = await request.handlers.exec(params, request.admittedContext("exec", params));
  expect(result.errorCode).toBe("exec_process_running");
  expect(result.output).not.toContain("Filesystem changes observed:");
  const processId = String(result.data!.processId);
  const stdout = [result.stdout ?? ""];
  const stderr = [result.stderr ?? ""];
  const deadline = Date.now() + 5000;
  while (result.errorCode === "exec_process_running" && Date.now() < deadline) {
    const wait = { process_id: processId, cursor: Number(result.data!.nextCursor) };
    result = await request.handlers.exec_wait(wait, request.admittedContext("exec_wait", wait));
    stdout.push(result.stdout ?? "");
    stderr.push(result.stderr ?? "");
  }

  expect(result).toMatchObject({
    ok: false,
    exitCode: 1,
    errorCode: "non_zero_exit",
    data: { processId, processStatus: "completed", mutationEvidence: true },
  });
  expect(result.output).toContain("Filesystem changes observed: 1 under CWD (.)");
  expect(result.error).toContain("Filesystem changes observed: 1 under CWD (.)");
  expect(stdout.join("")).toBe("started\n");
  expect(stderr.join("")).toBe("failed later\n");
  await expect(readFile(join(fixture.config.paths.agentWorkDir, "executed-once.txt"), "utf8"))
    .resolves.toBe("x");
}, 10_000);

test("an unavailable filesystem observation stays unknown instead of implying no changes", async () => {
  const { root, execution, snapshot } = await createTerminalEvidenceFixture();
  await writeFile(join(root, "unobserved.txt"), "saved");
  const result = await finalizeExecResult({
    snapshot,
    execution: { ...execution, filesystemStateBefore: null },
  });

  expect(result).toMatchObject({
    ok: false,
    exitCode: 1,
    errorCode: "non_zero_exit",
    actions: [],
    data: { filesystemObservation: { available: false } },
  });
  for (const text of [result.output, result.error]) {
    expect(text).toContain("Filesystem observation unavailable under CWD (.)");
    expect(text).toContain("changes are unknown");
    expect(text).not.toContain("No filesystem changes observed");
  }
  expect(result.data).not.toHaveProperty("mutationEvidence");
  await expect(readFile(join(root, "unobserved.txt"), "utf8")).resolves.toBe("saved");
});

test("an incomplete observation qualifies zero detected changes even when a new file exists", async () => {
  const { root, execution, snapshot } = await createTerminalEvidenceFixture();
  await writeFile(join(root, "new-outside-observed-set.txt"), "saved");
  const result = await finalizeExecResult({
    snapshot,
    execution: {
      ...execution,
      filesystemStateBefore: { ...execution.filesystemStateBefore!, complete: false },
    },
  });

  expect(result).toMatchObject({
    ok: false,
    exitCode: 1,
    errorCode: "non_zero_exit",
    actions: [],
    data: { filesystemObservation: { complete: false } },
  });
  for (const text of [result.output, result.error]) {
    expect(text).toContain("No filesystem changes observed under CWD (.)");
    expect(text).toContain("observation incomplete");
    expect(text).toContain("changes may be unobserved");
  }
  expect(result.data).not.toHaveProperty("mutationEvidence");
  await expect(readFile(join(root, "new-outside-observed-set.txt"), "utf8"))
    .resolves.toBe("saved");
});

test.each([
  ["hard_timeout", "exec_hard_timeout", 124],
  ["idle_timeout", "exec_idle_timeout", 124],
  ["aborted", "exec_aborted", 130],
] as const)("%s retains its failure classification alongside observed changes", async (terminationReason, errorCode, exitCode) => {
  const { root, execution, snapshot } = await createTerminalEvidenceFixture();
  await writeFile(join(root, "changed.txt"), "saved");
  const result = await finalizeExecResult({
    execution,
    snapshot: { ...snapshot, terminationReason, exitCode },
  });

  expect(result).toMatchObject({ ok: false, errorCode, exitCode, data: { mutationEvidence: true } });
  expect(result.error).toContain("Filesystem changes observed: 1 under CWD (.)");
  expect(result.error).toContain("does not establish that earlier effects were undone");
});

test("successful mutation and requested cancellation retain their successful outcomes", async () => {
  const { root, execution, snapshot } = await createTerminalEvidenceFixture();
  await writeFile(join(root, "changed.txt"), "saved");
  const completed = await finalizeExecResult({
    execution,
    snapshot: { ...snapshot, exitCode: 0 },
  });
  const cancelled = await finalizeExecResult({
    execution,
    snapshot: { ...snapshot, exitCode: 130, terminationReason: "cancelled" },
    cancellationIsSuccess: true,
  });

  expect(completed).toMatchObject({ ok: true, exitCode: 0 });
  expect(cancelled).toMatchObject({ ok: true, exitCode: 130, data: { processStatus: "cancelled" } });
  for (const result of [completed, cancelled]) {
    expect(result.error).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
    expect(result.output).toContain("Filesystem changes observed: 1 under CWD (.)");
  }
});

test("an empty successful process retains no_observable_result and its qualified observation", async () => {
  const { execution, snapshot } = await createTerminalEvidenceFixture();
  const result = await finalizeExecResult({ execution, snapshot: { ...snapshot, exitCode: 0 } });

  expect(result).toMatchObject({ ok: false, exitCode: 0, errorCode: "no_observable_result", actions: [] });
  expect(result.output).toContain("No filesystem changes observed under CWD (.)");
  expect(result.output).toContain("observation complete");
  expect(result.error).toContain("No filesystem changes observed under CWD (.)");
});
