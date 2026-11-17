import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type WebSocket from "ws";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import { capsules, decision, filesystemScopeFixture, type FilesystemModelInput } from "./support/filesystem-scope-integration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("EA carries a failed exact locator into a direct numeric read without controls or RAW calls", async () => {
  const fixture = await filesystemScopeFixture("execution-agent-v1", 64_000, ["filesystem-ea.read_text"]);
  const content = "header\nx target one\nmiddle\ny target two\nfooter";
  const file = join(fixture.config.paths.agentWorkDir, "notes.txt");
  const final = "The selected file section was read.";
  const inputs: FilesystemModelInput[] = [];
  try {
    await writeFile(file, content);
    const scripted = fixture.script([
      { step: "execution.decision", output: decision({ action: "open_capability_scope", catalogGroupIds: ["read"] }) },
      { step: "execution.decision", output: decision({
        action: "invoke_capability", capabilityId: "read_text", workingDirectory: ".",
        selectionControls: { path: "notes.txt", locator: "missing target", context_lines: 1, start_line: null, end_line: null },
      }) },
      { step: "execution.decision", output: decision({
        action: "invoke_capability", capabilityId: "read_text",
        selectionControls: { path: "notes.txt", start_line: 3, end_line: 5, locator: null, context_lines: null },
      }) },
      { step: "execution.decision", output: decision({ action: "respond" }) },
      { step: "execution.response", output: final },
    ], (input) => inputs.push(input));
    await handleRunRequest(
      { send: (data: string) => fixture.events.push(JSON.parse(data)) } as unknown as WebSocket,
      {
        type: "run_request", requestId: "ea-read-text-request", sessionId: "filesystem-session",
        input: "Read the second target section in notes.txt.", agentMode: "reasoning",
        toolPermissionMode: "full_access", modelPreference: { profileId: "scripted", scope: "all" },
      },
      { runtimeConfig: fixture.config, sessionStore: fixture.sessions,
        toolRegistry: fixture.registry, modelGatewayClient: scripted.model },
    );
    scripted.assertComplete();
    expect(inputs.map(({ modelStep }) => modelStep)).toEqual([
      "execution.decision", "execution.decision", "execution.decision", "execution.decision", "execution.response",
    ]);
    expect(capsules(inputs[1]!, "runtime_execution_capability_catalog_v1")[0]).toMatchObject({
      capabilities: [expect.objectContaining({ capabilityId: "read_text", effect: "observation" })],
    });
    expect(JSON.stringify(inputs[2]!.messages)).toContain("ea_locator_not_found");
    expect(JSON.stringify(inputs[3]!.messages)).toContain("y target two");
    const completed = fixture.events.filter(({ name }) => name === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ tool: "read_text", ok: false, meta: { errorCode: "ea_locator_not_found" } });
    expect(completed[1]).toMatchObject({
      tool: "read_text", ok: true,
      meta: { startLine: 3, endLine: 5, complete: false, truncated: false, outputPreview: "middle\ny target two\nfooter" },
    });
    expect(fixture.events).toContainEqual(expect.objectContaining({ type: "completed", output: final }));
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await fixture.sessions.getSessionById("filesystem-session"))?.messages.at(-1)?.content).toBe(final);
    expect(scripted.model.invokeRaw).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});
