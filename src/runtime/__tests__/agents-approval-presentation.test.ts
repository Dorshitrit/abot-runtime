import { expect, test } from "vitest";
import { publicApproval } from "../agents/workspace-public-view.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";

const commandPrefix = "  printf '<unsafe>'\n";
const command = commandPrefix + "x".repeat(24_576 - commandPrefix.length - 2) + " \t";
const cwd = " /project/" + "x".repeat(4_096 - 12) + " \t";
const metadataCases = [
  { tool: "exec", params: { command, cwd }, meta: { command, commandTruncated: false, cwd, cwdTruncated: false } },
  { tool: "read_file", params: { path: "notes.txt" }, meta: { path: "notes.txt", pathTruncated: false } },
];

for (const source of ["live", "saved"] as const) {
  test.each(metadataCases)(`${source} Agent approval preserves declared $tool details and exact decision identity`, ({ tool, params, meta }) => {
    const request = {
      requestId: "request-a", approvalId: "approval-a",
      call: { tool, params, clientStatus: "Prepared action", privateExecutionState: "private-call" },
      meta,
      context: "private-context", continuation: "private-continuation",
      executionId: "private-execution", roleCallId: "private-role", executorRole: "private-executor",
      undeclaredRequestField: "private-request",
    };
    const wait = { generation: "generation-a", waitId: "wait-a", revision: 7, continuation: "private-wait" };
    const input = {
      sessionId: "session-a", request,
      ...(source === "saved" && { wait }),
      context: "private-session", continuation: "private-outer",
    };
    const pending: LocalPendingToolApproval = source === "saved" ? structuredClone(input) : input;

    const view = publicApproval(pending);
    expect(view).toEqual({
      sessionId: "session-a",
      request: { requestId: "request-a", approvalId: "approval-a", call: { tool, params, clientStatus: "Prepared action" }, meta },
      ...(source === "saved" && { wait: { generation: "generation-a", waitId: "wait-a", revision: 7 } }),
    });
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toContain("private-");
  });
}

test("legacy Agent approval without metadata keeps its existing public shape", () => {
  const pending: LocalPendingToolApproval = {
    sessionId: "session-a",
    request: { requestId: "request-a", approvalId: "approval-a", call: { tool: "custom_tool", params: { input: "value" } } },
  };
  expect(publicApproval(pending)).toEqual({
    sessionId: "session-a",
    request: { requestId: "request-a", approvalId: "approval-a", call: { tool: "custom_tool", params: { input: "value" }, clientStatus: undefined } },
  });
  expect(publicApproval(pending).request).not.toHaveProperty("meta");
});
