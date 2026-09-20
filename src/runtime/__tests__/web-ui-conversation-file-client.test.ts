import { describe, expect, test } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

const input = {
  environmentId: "prod",
  sessionId: "s /?",
  requestId: "r&1",
  executionId: "e:1",
};
const payload = {
  ok: true,
  file: {
    name: "file.txt",
    mimeType: "text/plain",
    size: 0,
    kind: "text",
    content: "",
    truncated: false,
    operation: "created",
    downloadAvailable: true,
  },
};

function setup(
  data: unknown = payload,
  apiBasePath = "/web-api",
  backend = "runtime",
) {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath, backend }),
    getEnvironmentId: () => "prod",
    origin: "http://localhost:5177",
    fetchImpl: (async (url: RequestInfo | URL, options?: RequestInit) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(data));
    }) as typeof fetch,
  });
  return { client, calls };
}

describe("conversation file client", () => {
  test("bridge backend exposes no usable file action URLs", async () => {
    const { client, calls } = setup(payload, "/web-api", "bridge");
    expect(client.supportsConversationFiles()).toBe(false);
    expect(client.conversationFileUrl(input)).toBe("");
    await expect(client.loadConversationFile(input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("encodes every scoped ID, forwards cancellation, and never sends output paths", async () => {
    const { client, calls } = setup();
    const cancellation = new AbortController();
    await client.loadConversationFile({
      ...input,
      signal: cancellation.signal,
    });
    const url = new URL(calls[0].url, "http://localhost:5177");
    expect(url.pathname).toBe("/web-api/chat/files");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      environment: "prod",
      sessionId: "s /?",
      requestId: "r&1",
      executionId: "e:1",
    });
    expect(calls[0].options?.signal).toBe(cancellation.signal);
  });

  test("builds same-origin content and copy URLs", () => {
    const { client } = setup();
    expect(
      new URL(
        client.conversationFileUrl({ ...input, mode: "content" }),
        "http://localhost",
      ).searchParams.get("content"),
    ).toBe("1");
    expect(
      new URL(
        client.conversationFileUrl({ ...input, mode: "download" }),
        "http://localhost",
      ).searchParams.get("download"),
    ).toBe("1");
  });

  test("rejects a configured external API base before requesting file content", async () => {
    const { client, calls } = setup(payload, "https://other.example/web-api");
    expect(client.conversationFileUrl(input)).toBe("");
    await expect(client.loadConversationFile(input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test.each([
    { ...payload, file: { ...payload.file, kind: "html" } },
    { ...payload, file: { ...payload.file, size: -1 } },
    { ...payload, file: { ...payload.file, content: null } },
    {
      ...payload,
      file: { ...payload.file, kind: "image", mimeType: "image/svg+xml" },
    },
  ])("rejects malformed or unsafe preview responses", async (response) => {
    const { client } = setup(response);
    await expect(client.loadConversationFile(input)).rejects.toThrow(
      "Invalid file preview",
    );
  });
});

describe("native file client", () => {
  test("posts JSON with only scoped identifiers and forwards cancellation", async () => {
    const { client, calls } = setup({ ok: true });
    const cancellation = new AbortController();
    await client.openConversationFile({
      ...input,
      signal: cancellation.signal,
    });
    const url = new URL(calls[0].url, "http://localhost:5177");
    expect(url.pathname).toBe("/web-api/chat/files/open");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      environment: "prod",
      sessionId: "s /?",
      requestId: "r&1",
      executionId: "e:1",
    });
    expect(calls[0].options).toMatchObject({
      method: "POST",
      body: "{}",
      signal: cancellation.signal,
      headers: { "content-type": "application/json" },
    });
  });

  test.each(["bridge", "external"])(
    "rejects %s native action without a request",
    async (kind) => {
      const { client, calls } =
        kind === "bridge"
          ? setup({ ok: true }, "/web-api", "bridge")
          : setup({ ok: true }, "https://other.example/web-api");
      await expect(client.openConversationFile(input)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );
});
