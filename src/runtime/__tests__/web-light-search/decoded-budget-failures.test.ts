import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { describe, expect, test } from "vitest";

import { readLightConfig } from "../../../../plugins/web/source/light/config.js";
import { createLightTransport } from "../../../../plugins/web/source/light/crawl/transport.js";
import { createDocumentCache } from "../../../../plugins/web/source/light/documents/document-cache.js";
import { readLightDocument } from "../../../../plugins/web/source/light/documents/document-reader.js";
import { decodeLightResponse } from "../../../../plugins/web/source/light/documents/response-decoding.js";
import { fixtureResponse, fixtureSource } from "./search-fixture.js";

describe("Light failed decompression accounting", () => {
  test("does not retry a corrupt zlib wrapper as a second raw deflate stream", () => {
    const rawPayload = deflateRawSync(Buffer.alloc(100_000, 65));
    const wrappedTail = deflateRawSync(Buffer.alloc(35_000, 66));
    const body = Buffer.alloc(65_386 + wrappedTail.length + 4);
    // The zlib prefix emits output but has a bad checksum. Its bytes also
    // describe a separate valid raw stream, so retrying would double the work.
    body.set([0x78, 0x9c, 0x00, 0x63, 0xff, 0x9c, 0x00]);
    body.set(rawPayload, 161);
    body.set(wrappedTail, 65_386);
    const charges: number[] = [];
    expect(() =>
      decodeLightResponse(
        {
          ...fixtureResponse("https://publisher.example/page", "", {
            headers: { "content-encoding": "deflate" },
          }),
          body,
          bytesRead: body.length,
        },
        131_072,
        (count) => charges.push(count),
      ),
    ).toThrow(/encoded source is invalid/);
    expect(charges).toEqual([131_072]);
  });

  test.each([
    ["gzip", gzipSync(Buffer.alloc(4_096, 65))],
    ["br", brotliCompressSync(Buffer.alloc(4_096, 65))],
    ["deflate", deflateSync(Buffer.alloc(4_096, 65))],
    ["gzip", Buffer.from("invalid gzip")],
  ] as const)(
    "charges failed %s page output before another request",
    async (encoding, body) => {
      const config = {
        ...readLightConfig({ sources: [fixtureSource("publisher", "GPT")] }),
        maxResponseBytes: 1_024,
        maxTotalBytes: 1_536,
      };
      const requested: string[] = [];
      const session = createLightTransport({
        config,
        httpClient: {
          async get({ url }) {
            requested.push(url);
            if (url.endsWith("/robots.txt"))
              return fixtureResponse(url, "", { status: 404 });
            return {
              ...fixtureResponse(url, "", {
                headers: { "content-encoding": encoding },
              }),
              body,
              bytesRead: body.length,
            };
          },
        },
      }).createSession();
      const cache = createDocumentCache(config);
      const read = (path: string) =>
        readLightDocument({
          url: `https://publisher.example/${path}`,
          sourceId: "publisher",
          session,
          config,
          cache,
        });
      try {
        await expect(read("first")).rejects.toMatchObject({
          code: "web_response_invalid",
        });
        expect(session.snapshot().decodedBytes).toBe(1_024);
        await expect(read("second")).rejects.toMatchObject({
          code: "web_response_invalid",
        });
        expect(session.snapshot().decodedBytes).toBe(1_536);
        await expect(read("third")).rejects.toMatchObject({
          code: "web_search_budget_exhausted",
        });
        expect(session.snapshot().stopReason).toBe("byte_budget");
        expect(requested).not.toContain("https://publisher.example/third");
      } finally {
        session.dispose();
      }
    },
  );

  test("charges failed robots output before trying another origin", async () => {
    const config = {
      ...readLightConfig({
        sources: [fixtureSource("one", "GPT"), fixtureSource("two", "GPT")],
      }),
      maxResponseBytes: 1_024,
      maxTotalBytes: 1_024,
    };
    const body = gzipSync(Buffer.alloc(4_096, 65));
    const requested: string[] = [];
    const session = createLightTransport({
      config,
      httpClient: {
        async get({ url }) {
          requested.push(url);
          return {
            ...fixtureResponse(url, "", {
              headers: { "content-encoding": "gzip" },
            }),
            body,
            bytesRead: body.length,
          };
        },
      },
    }).createSession();
    try {
      await expect(
        session.get("https://one.example/page"),
      ).rejects.toMatchObject({ code: "web_search_source_blocked" });
      expect(session.snapshot().decodedBytes).toBe(1_024);
      await expect(
        session.get("https://two.example/page"),
      ).rejects.toMatchObject({ code: "web_search_budget_exhausted" });
      expect(requested).toEqual(["https://one.example/robots.txt"]);
    } finally {
      session.dispose();
    }
  });
});
