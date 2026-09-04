import { describe, expect, test } from "vitest";

import { readJsonBody } from "./request-body.js";
import { createChunkedJsonRequest } from "./__tests__/support/chunked-json-request.js";

describe("gateway HTTP request body decoding", () => {
  test("preserves Unicode at every possible two-chunk byte boundary", async () => {
    const body = { text: "שלום 🌍 café 𐍈", nested: { title: "עברית" } };
    const byteLength = Buffer.byteLength(JSON.stringify(body), "utf8");

    for (let split = 1; split < byteLength; split += 1) {
      const request = createChunkedJsonRequest(body, [split]);

      expect(await readJsonBody(request), `byte split ${split}`).toEqual(body);
    }
  });

  test("preserves multibyte text when every byte arrives separately", async () => {
    const body = { messages: [{ role: "user", content: "שלום 🌍 café 𐍈" }] };
    const byteLength = Buffer.byteLength(JSON.stringify(body), "utf8");
    const splits = Array.from(
      { length: byteLength - 1 },
      (_, index) => index + 1,
    );

    expect(await readJsonBody(createChunkedJsonRequest(body, splits))).toEqual(
      body,
    );
  });
});
