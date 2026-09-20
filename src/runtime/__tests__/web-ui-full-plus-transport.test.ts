import { describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function transport(config: Record<string, unknown> | null) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
    JSON.stringify({ requestId: "request-1" }), { status: 200 },
  ));
  const client = createRuntimeWebClient({
    getConfig: () => config, getEnvironmentId: () => "prod", fetchImpl,
    origin: "http://localhost:5177",
  });
  return { client, fetchImpl };
}

function request(toolPermissionMode: string) {
  return {
    text: "task", attachments: [], sessionId: "one", agentMode: "reasoning",
    toolPermissionMode,
  };
}

describe("FULL+ client and server compatibility", () => {
  test("sends the captured FULL+ wire value only to an advertising local server", async () => {
    const { client, fetchImpl } = transport({
      backend: "runtime", supportedToolPermissionModes: ["ask", "full_access", "full_plus"],
    });
    expect(await client.postChatMessage(request("full_plus"))).toBe("request-1");
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({ toolPermissionMode: "full_plus", sessionId: "one", environment: "prod" });
  });

  test.each([
    null,
    { backend: "runtime" },
    { backend: "runtime", supportedToolPermissionModes: ["ask", "full_access"] },
    { backend: "bridge", supportedToolPermissionModes: ["ask", "full_access", "full_plus"] },
  ])("rejects unsupported FULL+ before posting to %s", async (config) => {
    const { client, fetchImpl } = transport(config);
    await expect(client.postChatMessage(request("full_plus"))).rejects.toMatchObject({
      code: "full_plus_not_supported",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["ask", "full_access"])("retains the %s payload for an older server", async (mode) => {
    const { client, fetchImpl } = transport(null);
    await client.postChatMessage(request(mode));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).toolPermissionMode).toBe(mode);
  });

  test("rejects an unknown queued mode without a request or an implicit upgrade", async () => {
    const { client, fetchImpl } = transport({
      backend: "runtime", supportedToolPermissionModes: ["ask", "full_access", "full_plus"],
    });
    await expect(client.postChatMessage(request("future_mode"))).rejects.toMatchObject({
      code: "unsupported_tool_permission_mode",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
