import { describe, expect, test } from "vitest";
import { createChatgptAccountController } from "../../web-ui/app/controllers/chatgpt-account-controller.js";
import { RuntimeWebClientError } from "../../web-ui/app/services/runtime-web-client.js";
import { chatgptUiClient } from "./support/chatgpt-account-ui-fixture.js";

describe("ChatGPT account failure feedback", () => {
  test("local-only account reads and sign-in retain actionable feedback", async () => {
    const client = chatgptUiClient([]);
    const error = new RuntimeWebClientError("private server details", { status: 403, code: "chatgpt_local_only" });
    client.listChatgptAccounts.mockRejectedValue(error);
    client.startChatgptAttempt.mockRejectedValue(error);
    const flow = createChatgptAccountController({ client });
    await flow.load();
    expect(flow.state.loaded).toBe(true);
    expect(flow.state.busy).toBe("");
    expect(flow.state.error).toContain("direct local connection");
    expect(flow.state.error).toContain("Docker");
    expect(flow.state.error).not.toContain("private server details");
    const message = flow.state.error;
    await flow.start();
    expect(flow.state.busy).toBe("");
    expect(flow.state.error).toBe(message);
    expect(flow.state.attempt).toBeNull();
  });

  test("unknown server errors remain generic and do not expose their payload", async () => {
    const client = chatgptUiClient([]);
    client.listChatgptAccounts.mockRejectedValue(new RuntimeWebClientError("private server details", { status: 500, code: "unknown_failure" }));
    const flow = createChatgptAccountController({ client });
    await flow.load();
    expect(flow.state.loaded).toBe(true);
    expect(flow.state.busy).toBe("");
    expect(flow.state.error).toContain("accounts could not be loaded");
    expect(flow.state.error).not.toContain("private server details");
  });
});
