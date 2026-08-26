import { createServer, type RequestListener } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

// Public regression coverage for redirect and connection-pinning behavior.

import {
  createPublicHttpClient,
  requestPinnedHop,
  type HopRequester,
} from "../../../plugins/web/source/public-http.js";
import { WEB_LIMITS } from "../../../plugins/web/source/limits.js";

const EXAMPLE_PUBLIC_IPV4 = [93, 184, 216, 34].join(".");

afterEach(() => {
  vi.useRealTimers();
});

function response(params: {
  status?: number;
  location?: string;
  body?: string;
}) {
  const body = Buffer.from(params.body ?? "ok");
  return Object.freeze({
    status: params.status ?? 200,
    headers: params.location ? { location: params.location } : {},
    body,
    bytesRead: body.byteLength,
    partialContent: false,
  });
}

describe("public HTTP client", () => {
  test("pins a validated public DNS address into the request hop", async () => {
    const requestHop = vi.fn<HopRequester>(async () => response({}));
    const client = createPublicHttpClient({
      resolveHost: async () => [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }],
      requestHop,
    });

    await client.get({ url: "https://example.com/page" });

    expect(requestHop).toHaveBeenCalledOnce();
    expect(requestHop.mock.calls[0]?.[0]).toMatchObject({
      url: new URL("https://example.com/page"),
      address: { address: EXAMPLE_PUBLIC_IPV4, family: 4 },
    });
  });

  test("resolves and validates every redirect before connecting", async () => {
    const resolved: string[] = [];
    const requestHop = vi.fn<HopRequester>(async ({ url }) =>
      url.hostname === "example.com"
        ? response({ status: 302, location: "https://openai.com/final" })
        : response({ body: "done" }),
    );
    const client = createPublicHttpClient({
      resolveHost: async (hostname) => {
        resolved.push(hostname);
        return [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }];
      },
      requestHop,
    });

    const result = await client.get({ url: "https://example.com/start" });

    expect(resolved).toEqual(["example.com", "openai.com"]);
    expect(requestHop).toHaveBeenCalledTimes(2);
    expect(result.finalUrl).toBe("https://openai.com/final");
  });

  test("blocks a redirect to a private target before a second request", async () => {
    const requestHop = vi.fn<HopRequester>(async () =>
      response({ status: 302, location: "http://127.0.0.1/private" }),
    );
    const client = createPublicHttpClient({
      resolveHost: async () => [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }],
      requestHop,
    });

    await expect(
      client.get({ url: "https://example.com/start" }),
    ).rejects.toMatchObject({ code: "web_target_not_public" });
    expect(requestHop).toHaveBeenCalledOnce();
  });

  test("uses one absolute deadline across redirect hops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hopTimeouts: number[] = [];
    const requestHop: HopRequester = async ({ url, timeoutMs }) => {
      hopTimeouts.push(timeoutMs);
      vi.setSystemTime(Date.now() + 40);
      return url.pathname === "/one"
        ? response({ status: 302, location: "/two" })
        : response({});
    };
    const client = createPublicHttpClient({
      resolveHost: async () => [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }],
      requestHop,
    });

    await client.get({ url: "https://example.com/one", timeoutMs: 100 });

    expect(hopTimeouts).toHaveLength(2);
    expect(hopTimeouts[0]).toBeLessThanOrEqual(100);
    expect(hopTimeouts[1]).toBeLessThanOrEqual(60);
  });

  test("times out DNS resolution within the whole-request deadline", async () => {
    vi.useFakeTimers();
    const client = createPublicHttpClient({
      resolveHost: () => new Promise(() => undefined),
      requestHop: async () => response({}),
    });
    const pending = client.get({
      url: "https://example.com/",
      timeoutMs: 50,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "web_request_timed_out",
    });

    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });

  test("rejects mixed public and private DNS answers before connecting", async () => {
    const requestHop = vi.fn<HopRequester>(async () => response({}));
    const client = createPublicHttpClient({
      resolveHost: async () => [
        { address: EXAMPLE_PUBLIC_IPV4, family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      requestHop,
    });

    await expect(
      client.get({ url: "https://example.com/" }),
    ).rejects.toMatchObject({ code: "web_target_not_public" });
    expect(requestHop).not.toHaveBeenCalled();
  });

  test("bounds aggregate DNS and socket work across concurrent invocations", async () => {
    let activeHops = 0;
    let maximumActiveHops = 0;
    const client = createPublicHttpClient({
      resolveHost: async () => [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }],
      requestHop: async () => {
        activeHops += 1;
        maximumActiveHops = Math.max(maximumActiveHops, activeHops);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHops -= 1;
        return response({});
      },
    });

    await Promise.all(
      Array.from({ length: WEB_LIMITS.httpConcurrency * 3 }, (_, index) =>
        client.get({ url: `https://example.com/${index}` }),
      ),
    );

    expect(maximumActiveHops).toBeLessThanOrEqual(WEB_LIMITS.httpConcurrency);
  });

  test("retains timed-out DNS slots until the underlying lookups settle", async () => {
    const blockedResolvers: Array<
      (addresses: readonly [{ address: string; family: 4 }]) => void
    > = [];
    let resolverCalls = 0;
    const client = createPublicHttpClient({
      resolveHost: async () => {
        resolverCalls += 1;
        if (resolverCalls > WEB_LIMITS.httpConcurrency) {
          return [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }];
        }
        return await new Promise((resolve) => blockedResolvers.push(resolve));
      },
      requestHop: async () => response({}),
    });
    const saturated = Array.from(
      { length: WEB_LIMITS.httpConcurrency },
      (_, index) =>
        client
          .get({ url: `https://example.com/stuck-${index}`, timeoutMs: 20 })
          .catch((error: unknown) => error),
    );

    const failures = await Promise.all(saturated);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "web_request_timed_out" }),
      ]),
    );
    const afterTimeout = client.get({
      url: "https://example.com/after-timeout",
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(resolverCalls).toBe(WEB_LIMITS.httpConcurrency);

    for (const resolve of blockedResolvers) {
      resolve([{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }]);
    }
    await expect(afterTimeout).resolves.toMatchObject({ status: 200 });
    expect(resolverCalls).toBe(WEB_LIMITS.httpConcurrency + 1);
  });

  test("production hop pins the address and truncates the body byte-exactly", async () => {
    await withHttpServer(
      (request, responseMessage) => {
        expect(request.headers.host).toMatch(/^public\.example:/u);
        responseMessage.setHeader("content-type", "text/plain");
        responseMessage.end("0123456789abcdefghijklmnopqrstuvwxyz");
      },
      async (port) => {
        const result = await requestPinnedHop({
          url: new URL(`http://public.example:${port}/bounded`),
          address: { address: "127.0.0.1", family: 4 },
          headers: {},
          maxBytes: 10,
          timeoutMs: 1_000,
        });
        expect(result.bytesRead).toBe(10);
        expect(Buffer.from(result.body).toString("utf8")).toBe("0123456789");
        expect(result.partialContent).toBe(true);
      },
    );
  });

  test("production hop enforces response-header and abort bounds", async () => {
    await withHttpServer(
      (_request, responseMessage) => {
        responseMessage.setHeader("x-oversized", "x".repeat(40 * 1024));
        responseMessage.end("body");
      },
      async (port) => {
        await expect(
          requestPinnedHop({
            url: new URL(`http://public.example:${port}/headers`),
            address: { address: "127.0.0.1", family: 4 },
            headers: {},
            maxBytes: 100,
            timeoutMs: 1_000,
          }),
        ).rejects.toMatchObject({ code: "web_response_invalid" });
      },
    );

    await withHttpServer(
      () => undefined,
      async (port) => {
        const controller = new AbortController();
        const pending = requestPinnedHop({
          url: new URL(`http://public.example:${port}/abort`),
          address: { address: "127.0.0.1", family: 4 },
          headers: {},
          maxBytes: 100,
          timeoutMs: 1_000,
          abortSignal: controller.signal,
        });
        const assertion = expect(pending).rejects.toMatchObject({
          code: "web_request_aborted",
        });
        controller.abort();
        await assertion;
      },
    );
  });
});

async function withHttpServer(
  handler: RequestListener,
  operation: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing test server address");
    }
    await operation(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
