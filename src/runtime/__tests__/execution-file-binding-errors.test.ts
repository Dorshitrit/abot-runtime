import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestToolResult } from "../context/request-tool-results.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { fileHandoffFixture, type HandoffModelInput } from "./support/execution-file-handoff-fixture.js";
import { filePayloadOutput } from "./support/execution-file-output-fixture.js";

const fixtures: Awaited<ReturnType<typeof fileHandoffFixture>>[] = [];
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function nativeResult(input: HandoffModelInput, capabilityId: string) {
  for (const message of input.messages as readonly ChatMessage[]) {
    if (message.role !== "tool") continue;
    const envelope = JSON.parse(message.content) as { result: RequestToolResult };
    if (envelope.result?.capabilityId === capabilityId) return { message, result: envelope.result };
  }
  throw new Error(`missing_native_result:${capabilityId}`);
}

function selectedReadRange(input: HandoffModelInput): string {
  const { result } = nativeResult(input, "read_text");
  expect(result.outcome).toBe("succeeded");
  if (result.adapterResult?.kind !== "registered_tool_execution_result_v1") {
    throw new Error("expected_plugin_read_result");
  }
  const reference = result.adapterResult.result.data?.range_ref;
  if (typeof reference !== "string") throw new Error("missing_read_range_reference");
  return reference;
}

test.each([
  { phase: "before payload preparation", authorCalls: 0,
    message: "The file changed after the range was read. Read it again." },
  { phase: "during payload authoring", authorCalls: 1,
    message: "The target changed after payload preparation. Read it again." },
])("EA receives the original plugin error after drift $phase", async ({ phase, authorCalls, message }) => {
  const f = await fileHandoffFixture();
  fixtures.push(f);
  const file = join(f.root, "target.txt");
  const competingContent = "Changed by another actor.\n";
  await writeFile(file, "Original content.\n");
  let decisions = 0;
  f.invoke.mockImplementation(async (input) => {
    f.inputs.push(input);
    if (input.modelStep === "execution.file_payload.raw") {
      await writeFile(file, competingContent);
      return { text: filePayloadOutput(input.messages, "Proposed replacement.\n"), meta: {} };
    }
    if (input.modelStep === "execution.response") return { text: "The file changed; the edit was rejected.", meta: {} };
    if (input.modelStep !== "execution.decision") throw new Error(`unexpected_step:${input.modelStep}`);
    decisions++;
    if (decisions === 1) {
      return { text: JSON.stringify({ decision: {
        action: "open_capability_scope", catalogGroupIds: ["read", "write"],
      } }), meta: {} };
    }
    if (decisions === 2) {
      return { text: JSON.stringify({ decision: {
        action: "invoke_capability", capabilityId: "read_text", workingDirectory: null,
        selectionControls: { path: "target.txt", start_line: 1, end_line: 1, locator: null },
      } }), meta: {} };
    }
    if (decisions === 3) {
      const range_ref = selectedReadRange(input);
      if (phase === "before payload preparation") await writeFile(file, competingContent);
      return { text: JSON.stringify({ decision: {
        action: "invoke_capability", capabilityId: "edit_text",
        operationObjective: "Replace the selected range with the requested content.",
        selectionControls: { path: "target.txt", range_ref },
      } }), meta: {} };
    }
    expect(decisions).toBe(4);
    return { text: JSON.stringify({ decision: { action: "respond" } }), meta: {} };
  });

  await runRequestRunner(f.request);

  const nextDecision = f.inputs.filter(({ modelStep }) => modelStep === "execution.decision")[3]!;
  const response = f.inputs.find(({ modelStep }) => modelStep === "execution.response")!;
  const expectedRejection = {
    kind: "runtime_capability_rejection_v1", authority: "runtime",
    stage: "before_external_execution", code: "filesystem_target_changed", message,
  };
  for (const input of [nextDecision, response]) {
    const native = nativeResult(input, "edit_text");
    expect(native.result).toMatchObject({
      outcome: "failed", observedEffect: "none", summary: message, adapterResult: expectedRejection,
    });
    expect(native.message.toolCallId).toBe(native.result.executionId);
    const messages = input.messages as readonly ChatMessage[];
    const invocation = messages[messages.indexOf(native.message) - 1];
    expect(invocation).toMatchObject({ role: "assistant", toolCalls: [{ callId: native.result.executionId }] });
  }
  expect(nativeResult(response, "edit_text").message).toEqual(nativeResult(nextDecision, "edit_text").message);
  expect(f.inputs.filter(({ modelStep }) => modelStep === "execution.file_payload.raw")).toHaveLength(authorCalls);
  expect(await readFile(file, "utf8")).toBe(competingContent);
  expect(f.events.filter(({ name, tool }) => tool === "edit_text" && name === "tool.started")).toEqual([]);
  expect(f.events.filter(({ name, tool }) => tool === "edit_text" && name === "tool.completed")).toEqual([]);
});
