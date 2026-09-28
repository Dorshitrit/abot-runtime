import { describe, expect, test, vi } from "vitest";
import { RequestToolMediaStore } from "../attachments/request-tool-media.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { projectToolMediaMessages } from "../context/tool-media-projection.js";
import { normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { successResult } from "../../plugin-sdk/results.js";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import { toolImageFixture, toolImageMessages } from "./support/tool-media-fixture.js";

const owner = { callId: "call-1", executionId: "execution-1" };
const input = () => ({ bytes: toolImageFixture(), mimeType: "image/png" });

async function fixture() {
  const store = new RequestToolMediaStore();
  const execution = store.beginExecution(owner, new AbortController().signal);
  const reference = await execution.writer.writeImage(input());
  execution.finish([reference]);
  return { store, execution, reference };
}

describe("request-owned tool image evidence", () => {
  test("preserves exact pixels and metadata across SDK and canonical result validation", async () => {
    const store = new RequestToolMediaStore();
    const execution = store.beginExecution(owner, new AbortController().signal);
    const result = await executeToolCall({ tool: "fixture", params: {} }, {
      media: execution.writer,
      implementations: { fixture: async (_params, context) => successResult({
        output: "Observed pixels.", media: [await context!.media!.writeImage(input())],
      }) },
    });
    execution.finish(result.media);
    const captured = normalizeCapabilityAdapterResult({ kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed", result });
    expect(captured.ok).toBe(true);
    expect(result.media?.[0]).toMatchObject({ width: 2, height: 1, mimeType: "image/png" });
    expect(store.resolve(owner, result.media![0]!)).toBe(toolImageFixture().toString("base64"));
    expect(JSON.stringify(captured)).not.toContain(toolImageFixture().toString("base64"));
    store.dispose();
  });

  test("rejects another execution, forged metadata and a different request", async () => {
    const { store, reference } = await fixture();
    expect(() => store.resolve({ ...owner, callId: "other" }, reference)).toThrow("mismatch");
    expect(() => store.resolve(owner, { ...reference, width: 99 })).toThrow("invalid");
    expect(() => new RequestToolMediaStore().resolve(owner, reference)).toThrow("unavailable");
    const another = store.beginExecution({ ...owner, executionId: "execution-2" }, new AbortController().signal);
    expect(() => another.finish([reference])).toThrow("mismatch");
    store.dispose();
  });

  test("only published images survive an execution and image counts stay bounded", async () => {
    const store = new RequestToolMediaStore();
    const execution = store.beginExecution(owner, new AbortController().signal);
    const references = await Promise.all(Array.from({ length: 4 }, () => execution.writer.writeImage(input())));
    await expect(execution.writer.writeImage(input())).rejects.toThrow("execution_limit");
    execution.finish([references[0]!]);
    expect(store.resolve(owner, { ...references[0]! })).toBe(toolImageFixture().toString("base64"));
    expect(() => store.resolve(owner, references[1]!)).toThrow("unavailable");
    await expect(execution.writer.writeImage(input())).rejects.toThrow("execution_closed");
    store.dispose();
  });

  test("rejects corrupt pixels, oversized bodies, late writes and aborted writers", async () => {
    const store = new RequestToolMediaStore();
    const controller = new AbortController();
    const execution = store.beginExecution(owner, controller.signal);
    const corrupted = toolImageFixture();
    corrupted[40] ^= 1;
    await expect(execution.writer.writeImage({ bytes: corrupted, mimeType: "image/png" })).rejects.toThrow("invalid");
    await expect(execution.writer.writeImage({ bytes: new Uint8Array(11 * 1024 * 1024), mimeType: "image/png" })).rejects.toThrow("size_invalid");
    controller.abort();
    await expect(execution.writer.writeImage(input())).rejects.toThrow();
    store.dispose();
    await expect(execution.writer.writeImage(input())).rejects.toThrow("request_closed");
  });

  test.each(["root", "worker"] as const)("%s preserves existing roles and attaches original pixels only to evidence", async (lane) => {
    const { store, reference } = await fixture();
    const messages = toolImageMessages(reference, lane);
    const projected = projectToolMediaMessages({ messages, store, modelStep: lane === "root" ? "execution.decision" : "worker.decision", supportsImages: true });
    expect(projected.map(({ role }) => role)).toEqual(messages.map(({ role }) => role));
    expect(projected.at(-1)?.attachments?.[0]?.data).toBe(toolImageFixture().toString("base64"));
    expect(projected[0]?.attachments).toBeUndefined();
    expect(messages.at(-1)?.attachments).toBeUndefined();
    expect(projectToolMediaMessages({ messages, store, modelStep: "planner.decision", supportsImages: true })).toEqual(messages);
    store.dispose();
  });

  test("unsupported vision is explicit; compacted or summary-only results gain no images", async () => {
    const { store, reference } = await fixture();
    const messages = toolImageMessages(reference);
    const projected = projectToolMediaMessages({ messages, store, modelStep: "execution.decision", supportsImages: false });
    expect(projected.at(-1)?.attachments).toBeUndefined();
    expect(JSON.parse(projected.at(-1)!.content).mediaDelivery.status).toBe("unsupported_image_input");
    const compacted = [{ role: "user" as const, content: JSON.stringify({ kind: "runtime_request_tool_results_v1", results: [], semanticCheckpoint: { coveredResults: [{ executionId: "execution-1" }] } }) }];
    expect(projectToolMediaMessages({ messages: compacted, store, modelStep: "worker.decision", supportsImages: true })).toEqual(compacted);
    store.dispose();
  });

  test("success disposal releases generic callbacks exactly once despite cleanup failures", async () => {
    const resources = new RequestToolResources();
    const first = vi.fn(async () => { throw new Error("cleanup failure"); });
    const second = vi.fn();
    resources.onRequestDispose(first);
    resources.onRequestDispose(second);
    const execution = resources.media.beginExecution(owner, new AbortController().signal);
    const reference = await execution.writer.writeImage(input());
    execution.finish([reference]);
    await resources.dispose();
    await resources.dispose();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(() => resources.media.resolve(owner, reference)).toThrow("request_closed");
  });
});
