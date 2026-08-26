import { describe, expect, test, vi } from "vitest";

import { executeToolCall } from "../tool-executor.js";

describe("tool execution flow", () => {
  test("passes the request-bound model invoker to the implementation", async () => {
    const invokeText = vi.fn();
    const modelInvoker = { invokeText };
    let receivedModelInvoker: unknown;

    await executeToolCall(
      { tool: "model_assisted", params: {} },
      {
        modelInvoker,
        implementations: {
          model_assisted: async (_params, context) => {
            receivedModelInvoker = context?.modelInvoker;
            return {
              ok: true,
              output: "ok",
              progress: true,
              producedNewInformation: true,
            };
          },
        },
      },
    );

    expect(receivedModelInvoker).toBe(modelInvoker);
  });

  test("dispatches tool call to implementation", async () => {
    const executed = await executeToolCall(
      { tool: "web_search", params: { query: "openai" } },
      {
        implementations: {
          web_search: async (params) => ({
            ok: true,
            output: `result for ${(params.query as string) || ""}`,
            progress: true,
            producedNewInformation: true,
          }),
        },
      },
    );

    expect(executed).toEqual({
      ok: true,
      tool: "web_search",
      output: "result for openai",
      progress: true,
      producedNewInformation: true,
    });
  });

  test("preserves explicit mutation evidence from tool output", async () => {
    const executed = await executeToolCall(
      { tool: "write_file", params: { path: "memory/a.txt", content: "a" } },
      {
        implementations: {
          write_file: async () => ({
            ok: true,
            output: "write ok",
            progress: true,
            producedNewInformation: true,
            data: { mutationEvidence: true },
          }),
        },
      },
    );

    expect(executed.ok).toBe(true);
    expect(executed.data?.mutationEvidence).toBe(true);
  });

  test("preserves observation metadata from tool output", async () => {
    const executed = await executeToolCall(
      { tool: "memory_search", params: { query: "name" } },
      {
        implementations: {
          memory_search: async () => ({
            ok: true,
            output: "My name is Test User.",
            progress: true,
            producedNewInformation: true,
            data: {
              hasData: true,
              observationMeta: {
                kind: "stable_fact",
                carryPolicy: "always",
              },
            },
          }),
        },
      },
    );

    expect(executed.ok).toBe(true);
    expect(executed.data?.observationMeta).toEqual({
      kind: "stable_fact",
      carryPolicy: "always",
    });
  });

  test("returns explicit fallback for unimplemented tools", async () => {
    const executed = await executeToolCall(
      { tool: "missing_tool", params: {} },
      { implementations: {} },
    );

    expect(executed.ok).toBe(false);
    expect(executed.output).toBe("Tool missing_tool not implemented");
    expect(executed.progress).toBe(false);
    expect(executed.producedNewInformation).toBe(false);
    expect(executed.errorCode).toBe("not_implemented");
  });

  test("converts tool errors to deterministic result", async () => {
    const executed = await executeToolCall(
      { tool: "web_search", params: { query: "x" } },
      {
        implementations: {
          web_search: async () => {
            throw new Error("network down");
          },
        },
      },
    );

    expect(executed.ok).toBe(false);
    expect(executed.error).toBe("network down");
    expect(executed.output).toBe("network down");
    expect(executed.progress).toBe(false);
    expect(executed.producedNewInformation).toBe(false);
    expect(executed.errorCode).toBe("tool_execution_failed");
  });

  test("rejects an implementation result that omits the mandatory contract", async () => {
    const executed = await executeToolCall(
      { tool: "invalid_tool", params: {} },
      {
        implementations: {
          invalid_tool: async () =>
            ({
              output: "untrusted result",
              producedNewInformation: true,
            }) as never,
        },
      },
    );

    expect(executed).toMatchObject({
      ok: false,
      tool: "invalid_tool",
      output:
        "tool implementations must return ok, output, and producedNewInformation",
      progress: false,
      producedNewInformation: false,
      errorCode: "tool_result_invalid",
    });
  });

  test("preserves explicit failed execution results from implementations", async () => {
    const executed = await executeToolCall(
      { tool: "exec", params: { command: "mkdir existing" } },
      {
        implementations: {
          exec: async () => ({
            ok: false,
            output: "Exit code: 1\nSTDOUT:\n(empty)\nSTDERR:\nFile exists",
            progress: true,
            producedNewInformation: true,
            actions: [{ type: "unknown", details: "mkdir existing" }],
            exitCode: 1,
            stdout: "(empty)",
            stderr: "File exists",
            error: "File exists",
            errorCode: "non_zero_exit",
          }),
        },
      },
    );

    expect(executed).toMatchObject({
      ok: false,
      tool: "exec",
      progress: false,
      producedNewInformation: false,
      actions: [{ type: "unknown", details: "mkdir existing" }],
      exitCode: 1,
      stdout: "(empty)",
      stderr: "File exists",
      error: "File exists",
      errorCode: "non_zero_exit",
    });
  });

  test("logs bounded action metadata without action targets or details", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sensitiveTarget =
      "/private/runtime/agent-work/request-123/artifact.txt";
    const sensitiveDetails = "private implementation detail";

    await executeToolCall(
      { tool: "write_file", params: {} },
      {
        implementations: {
          write_file: async () => ({
            ok: true,
            output: "write ok",
            progress: true,
            producedNewInformation: true,
            actions: [
              {
                type: "establish_target",
                target: sensitiveTarget,
                details: sensitiveDetails,
              },
            ],
          }),
        },
      },
    );

    const progressLog = log.mock.calls
      .map(([entry]) => String(entry))
      .find((entry) => entry.includes('"event":"tool.progress.signal"'));
    expect(progressLog).toBeDefined();
    expect(JSON.parse(progressLog!)).toMatchObject({
      tool: "write_file",
      progress: true,
      producedNewInformation: true,
      actionCount: 1,
      actionTypes: ["establish_target"],
    });
    expect(progressLog).not.toContain(sensitiveTarget);
    expect(progressLog).not.toContain(sensitiveDetails);
  });
});
