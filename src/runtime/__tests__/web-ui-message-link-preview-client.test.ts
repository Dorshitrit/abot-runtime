import { afterEach, describe, expect, test, vi } from "vitest";

import { createMessageLinkPreviewClient } from "../../web-ui/app/services/message-link-preview-client.js";

function response(title = "A preview") {
  return {
    ok: true,
    json: async () => ({ ok: true, preview: { title } }),
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("web ui link preview requests", () => {
  test("deduplicates pending and settled requests and sends the same-origin header", async () => {
    let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const client = createMessageLinkPreviewClient({ fetchImpl });
    const first = client.get("https://example.com/a?b=2");
    const repeated = client.get("https://example.com/a?b=2");
    expect(repeated).toBe(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]).toMatchObject([
      "/web-link-preview?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D2",
      { headers: { "X-Abot-Link-Preview": "1" }, credentials: "same-origin" },
    ]);
    client.cancelQueued();
    expect(client.get("https://example.com/a?b=2")).toBe(first);
    resolve(response());
    expect(await first).toMatchObject({ title: "A preview" });
    expect(await client.get("https://example.com/a?b=2")).toEqual(await first);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("limits concurrent work and discards obsolete queued requests", async () => {
    const finishes: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const client = createMessageLinkPreviewClient({ fetchImpl });
    const requests = Array.from({ length: 80 }, (_, index) =>
      client.get(`https://example.com/${index}`),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await requests[79]).toBeNull();
    client.cancelQueued();
    expect(await requests[3]).toBeNull();
    for (const finish of finishes) finish(response());
    await Promise.all(requests);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("starts waiting work only after an active request settles", async () => {
    const finishes: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const client = createMessageLinkPreviewClient({ fetchImpl });
    const requests = [0, 1, 2, 3].map((index) =>
      client.get(`https://example.com/${index}`),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    finishes[0](response());
    await requests[0];
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const finish of finishes.slice(1)) finish(response());
    await Promise.all(requests);
  });

  test("keeps failures quiet and cached across rerenders", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Unavailable"));
    const client = createMessageLinkPreviewClient({ fetchImpl });
    expect(await client.get("https://example.com/")).toBeNull();
    expect(await client.get("https://example.com/")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("expires metadata before image tokens and bounds the cache", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    const client = createMessageLinkPreviewClient({ fetchImpl });
    await client.get("https://example.com/first");
    now.mockReturnValue(4 * 60 * 1_000);
    await client.get("https://example.com/first");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 100; index += 1) {
      await client.get(`https://example.com/${index}`);
    }
    await client.get("https://example.com/first");
    expect(fetchImpl).toHaveBeenCalledTimes(103);
  });
});
