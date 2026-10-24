import { describe, expect, test, vi } from "vitest";
import { createToolApprovalRequests } from "../../web-ui/app/services/runtime-web-client/tool-approvals.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

describe("Home approval client transport", () => {
  test("serializes captured scope and decision while another environment is selected", async () => {
    const requestApi = vi.fn(async () => ({
      ok: true,
      approvalId: "approval /?",
    }));
    const client = createToolApprovalRequests({
      requestApi,
      getConfig: () => ({ backend: "runtime" }),
      getEnvironmentId: () => "different",
    });
    await client.decideToolApproval({
      approvalId: "approval /?",
      environmentId: "prod",
      sessionId: "session",
      requestId: "request",
      approved: false,
    });
    expect(requestApi).toHaveBeenCalledExactlyOnceWith(
      "/chat/approvals/approval%20%2F%3F",
      {
        method: "POST",
        body: JSON.stringify({
          environment: "prod",
          sessionId: "session",
          requestId: "request",
          approved: false,
        }),
      },
    );
  });

  test("forwards an existing reason unchanged in the HTTP decision", async () => {
    const requestApi = vi.fn(async () => ({
      ok: true,
      approvalId: "approval",
    }));
    const client = createToolApprovalRequests({
      requestApi,
      getConfig: () => ({ backend: "runtime" }),
      getEnvironmentId: () => "prod",
    });
    const reason = "User explanation:\nPlease choose another target.";
    await client.decideToolApproval({
      environmentId: "prod",
      sessionId: "session",
      requestId: "request",
      approvalId: "approval",
      approved: false,
      reason,
      generation: "generation",
      waitId: "wait",
      revision: 3,
      commandId: "decision",
    });
    const body = JSON.parse(
      (requestApi.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body).toEqual({
      environment: "prod",
      sessionId: "session",
      requestId: "request",
      approved: false,
      reason,
      generation: "generation",
      waitId: "wait",
      revision: 3,
      commandId: "decision",
    });
  });

  test("bridge makes no unsupported requests", async () => {
    const requestApi = vi.fn(async () => ({}));
    const client = createToolApprovalRequests({
      requestApi,
      getConfig: () => ({ backend: "bridge" }),
      getEnvironmentId: () => "prod",
    });
    expect(client.supportsToolApprovals()).toBe(false);
    await expect(client.listToolApprovals()).rejects.toThrow("unavailable");
    await expect(
      client.decideToolApproval({
        environmentId: "prod",
        sessionId: "s",
        requestId: "r",
        approvalId: "a",
        approved: true,
      }),
    ).rejects.toThrow("unavailable");
    expect(requestApi).not.toHaveBeenCalled();
  });

  test("rejects mismatched server identity before rendering actionable details", async () => {
    const requestApi = vi.fn(async () => ({
      approvals: [
        {
          environmentId: "prod",
          sessionId: "s",
          requestId: "r",
          approvalId: "a",
          event: {
            name: "tool.approval.required",
            requestId: "different",
            approvalId: "a",
          },
        },
      ],
    }));
    const client = createToolApprovalRequests({
      requestApi,
      getConfig: () => ({ backend: "runtime" }),
      getEnvironmentId: () => "prod",
    });
    await expect(client.listToolApprovals()).rejects.toThrow(
      "Invalid approval identity",
    );
  });

  test("the composed client reads the native list through its configured API base", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true, approvals: [] })),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ backend: "runtime", apiBasePath: "/custom" }),
      getEnvironmentId: () => "prod",
      origin: "http://localhost",
      fetchImpl,
    });
    expect(await client.listToolApprovals("dev & review")).toEqual({
      ok: true,
      approvals: [],
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/custom/chat/approvals?environment=dev%20%26%20review",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
