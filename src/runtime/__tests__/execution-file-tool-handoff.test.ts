import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { fileHandoffFixture, createSelection, toolSelection } from "./support/execution-file-handoff-fixture.js";
import { filePayloadOutput } from "./support/execution-file-output-fixture.js";
import { filePayloadEvidence } from "./support/execution-file-payload-fixture.js";
import type { ChatMessage } from "../../model-gateway/types.js";

const fixtures: Awaited<ReturnType<typeof fileHandoffFixture>>[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function fixture(permission: "ask" | "full_access" = "full_access") {
  const f = await fileHandoffFixture(permission);
  fixtures.push(f);
  await writeFile(join(f.root, "dependency.txt"), "CANONICAL_DEPENDENCY\r\n");
  return f;
}

test.each([false, true])("author-selected tool returns its canonical result before writing; failed=%s", async (failed) => {
  const f = await fixture();
  f.authors.push(
    (input) => f.tool(input, toolSelection(failed ? "missing.txt" : "dependency.txt")),
    async (input) => {
      await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
      const evidence = filePayloadEvidence(input.messages as ChatMessage[]);
      const result = evidence.settledCapabilityResults.find((entry: { capabilityId: string }) => entry.capabilityId === "read_text");
      expect(result).toMatchObject({ outcome: failed ? "failed" : "succeeded" });
      if (!failed) expect(JSON.stringify(result)).toContain("CANONICAL_DEPENDENCY");
      return filePayloadOutput(input.messages, failed ? "Dependency is unavailable." : "CANONICAL_DEPENDENCY\r\n", failed ? "abort" : "write");
    },
  );
  await runRequestRunner(f.request);
  expect(f.inputs.map(({ modelStep }) => modelStep)).toEqual([
    "execution.decision", "execution.decision", "execution.file_payload.raw",
    "execution.file_payload.raw", "execution.decision", "execution.response",
  ]);
  if (failed) await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
  else expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("CANONICAL_DEPENDENCY\r\n");
});

test.each(["target.txt", "intermediate.txt"])("an author-selected mutation of %s cannot execute or recurse", async (path) => {
  const f = await fixture();
  f.authors.push((input) => f.tool(input, createSelection(path)));
  await runRequestRunner(f.request);
  await expect(readFile(join(f.root, path))).rejects.toThrow();
  await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
  expect(f.authors).toHaveLength(0);
  expect(f.events.filter(({ name }) => name === "tool.completed")).toHaveLength(0);
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(1);
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.decision")).toHaveLength(3);
});

test.each(["full_access", "ask"] as const)("an observation batch resumes the write across %s approval boundaries", async (permission) => {
  const f = await fixture(permission);
  await writeFile(join(f.root, "second.txt"), "SECOND_DEPENDENCY\n");
  f.authors.push(
    (input) => f.tool(input, { action: "invoke_capabilities", invocations: [
      { capabilityId: "read_text", selectionControls: { path: "dependency.txt" } },
      { capabilityId: "read_text", selectionControls: { path: "second.txt" } },
    ] }),
    (input) => {
      const evidence = filePayloadEvidence(input.messages as ChatMessage[]);
      const observations = evidence.settledCapabilityResults.filter((entry: { capabilityId: string }) => entry.capabilityId === "read_text");
      expect(observations).toHaveLength(2);
      expect(JSON.stringify(observations)).toContain("CANONICAL_DEPENDENCY");
      expect(JSON.stringify(observations)).toContain("SECOND_DEPENDENCY");
      return filePayloadOutput(input.messages, "COMBINED\n");
    },
  );
  const result = await runRequestRunner(f.request, { durableApproval: true });
  if (permission === "ask") {
    if (result.kind !== "awaiting_approval") throw new Error("expected_batch_approval");
    expect(result.continuation.preparedGroup.entries).toHaveLength(2);
    expect(result.continuation.preparedGroup.entries.every((entry) => entry.declaredEffect === "observation")).toBe(true);
    const restored = await f.compose(JSON.parse(JSON.stringify(f.state.snapshot())));
    const continuation = JSON.parse(JSON.stringify(result.continuation));
    const resumed = await runRequestRunner(restored.request, { durableApproval: true, continuation,
      decisions: continuation.preparedGroup.entries.map((entry: { approvalRequest: { approvalId: string }; actionFingerprint: string }) => ({
        approvalId: entry.approvalRequest.approvalId, actionFingerprint: entry.actionFingerprint, decision: { approved: true },
      })),
    });
    if (resumed.kind !== "awaiting_approval") throw new Error("expected_parent_write_approval");
    const next = JSON.parse(JSON.stringify(resumed.continuation));
    const again = await f.compose(JSON.parse(JSON.stringify(restored.state.snapshot())));
    const done = await runRequestRunner(again.request, { durableApproval: true, continuation: next,
      decisions: next.preparedGroup.entries.map((entry: { approvalRequest: { approvalId: string }; actionFingerprint: string }) => ({
        approvalId: entry.approvalRequest.approvalId, actionFingerprint: entry.actionFingerprint, decision: { approved: true },
      })),
    });
    expect(done.kind).toBe("completed");
  }
  expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("COMBINED\n");
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(2);
});

test.each([true, false])("tool approval survives a cold restore and writing continues; approved=%s", async (approved) => {
  const f = await fixture("ask");
  f.authors.push((input) => f.tool(input), (input) => {
    const evidence = JSON.stringify(filePayloadEvidence(input.messages as ChatMessage[]));
    expect(evidence).toContain(approved ? "CANONICAL_DEPENDENCY" : "denied");
    return filePayloadOutput(input.messages, approved ? "APPROVED\n" : "Read denied.", approved ? "write" : "abort");
  });
  const waiting = await runRequestRunner(f.request, { durableApproval: true });
  if (waiting.kind !== "awaiting_approval") throw new Error("expected_tool_approval");
  await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(1);
  const restored = await f.compose(JSON.parse(JSON.stringify(f.state.snapshot())));
  const continuation = JSON.parse(JSON.stringify(waiting.continuation));
  const resumed = await runRequestRunner(restored.request, { durableApproval: true, continuation,
    decisions: continuation.preparedGroup.entries.map((entry: { approvalRequest: { approvalId: string }; actionFingerprint: string }) => ({
      approvalId: entry.approvalRequest.approvalId, actionFingerprint: entry.actionFingerprint, decision: { approved },
    })),
  });
  if (!approved) {
    expect(resumed.kind).toBe("completed");
    await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
    return;
  }
  if (resumed.kind !== "awaiting_approval") throw new Error("expected_original_write_approval");
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(2);
  const next = JSON.parse(JSON.stringify(resumed.continuation));
  const again = await f.compose(JSON.parse(JSON.stringify(restored.state.snapshot())));
  const done = await runRequestRunner(again.request, { durableApproval: true, continuation: next,
    decisions: next.preparedGroup.entries.map((entry: { approvalRequest: { approvalId: string }; actionFingerprint: string }) => ({
      approvalId: entry.approvalRequest.approvalId, actionFingerprint: entry.actionFingerprint, decision: { approved: true },
    })),
  });
  expect(done.kind).toBe("completed");
  expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("APPROVED\n");
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(2);
});

test.each([
  { action: "invoke_capability", capabilityId: "unavailable_tool", selectionControls: {} },
  { action: "invoke_capability", capabilityId: "read_text", selectionControls: { path: 123 } },
  { action: "respond" },
])("invalid tool selection cannot execute or write: %j", async (selection) => {
  const f = await fixture();
  f.authors.push((input) => f.tool(input, selection));
  await runRequestRunner(f.request);
  await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
  expect(f.events.filter(({ name }) => name === "tool.completed")).toHaveLength(0);
  expect(JSON.stringify(f.inputs.at(-2)?.messages)).toContain("payload_model_output_invalid");
});

test.each(["source", "steering"])("a changed %s prevents the old write after tool approval", async (changed) => {
  const f = await fixture("ask");
  f.authors.push((input) => f.tool(input));
  const waiting = await runRequestRunner(f.request, { durableApproval: true });
  if (waiting.kind !== "awaiting_approval") throw new Error("expected_tool_approval");
  if (changed === "source") await writeFile(join(f.root, "target.txt"), "EXTERNAL_CONTENT\n");
  else f.steering.append({ steerId: "cancel-write", text: "Do not write the file. Report only." });
  const continuation = JSON.parse(JSON.stringify(waiting.continuation));
  const restored = await f.compose(JSON.parse(JSON.stringify(f.state.snapshot())));
  const done = await runRequestRunner(restored.request, { durableApproval: true, continuation,
    decisions: continuation.preparedGroup.entries.map((entry: { approvalRequest: { approvalId: string }; actionFingerprint: string }) => ({
      approvalId: entry.approvalRequest.approvalId, actionFingerprint: entry.actionFingerprint, decision: { approved: true },
    })),
  });
  expect(done.kind).toBe("completed");
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(1);
  if (changed === "source") expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("EXTERNAL_CONTENT\n");
  else await expect(readFile(join(f.root, "target.txt"))).rejects.toThrow();
});
