import { describe, expect, test } from "vitest";

import { createAggregateGate } from "../../../plugins/web/source/aggregate-gate.js";
import {
  remainingTime,
  withinDeadline,
} from "../../../plugins/web/source/deadline.js";
import {
  WebPluginError,
  isWebPluginError,
} from "../../../plugins/web/source/errors.js";
import {
  parsePublicHttpUrl,
  resolvePublicTarget,
} from "../../../plugins/web/source/network-policy.js";
import {
  createPublicHttpClient,
  requestPinnedHop,
} from "../../../plugins/web/source/public-http.js";

const EXAMPLE_PUBLIC_IPV4 = [93, 184, 216, 34].join(".");

describe("Web plugin shared transport compatibility", () => {
  test("preserves plugin error identity and codes for URL and deadline failures", async () => {
    expect(() => parsePublicHttpUrl("http://127.0.0.1")).toThrow(
      WebPluginError,
    );
    expect(() => remainingTime(Date.now() - 1)).toThrow(WebPluginError);
    const controller = new AbortController();
    controller.abort();
    const operations = [
      resolvePublicTarget(new URL("https://example.com"), async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
      createPublicHttpClient().get({ url: "file:///private" }),
      withinDeadline(
        Promise.resolve("unused"),
        Date.now() + 1_000,
        controller.signal,
      ),
      createAggregateGate(1, 1).run(
        async () => "unused",
        Date.now() + 1_000,
        controller.signal,
      ),
      requestPinnedHop({
        url: new URL("https://example.com"),
        address: { address: EXAMPLE_PUBLIC_IPV4, family: 4 },
        headers: {},
        maxBytes: 1,
        timeoutMs: 1_000,
        abortSignal: controller.signal,
      }),
    ];
    const errors = await Promise.all(
      operations.map((operation) => operation.catch((error) => error)),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(WebPluginError);
      expect(isWebPluginError(error)).toBe(true);
      expect(error.name).toBe("WebPluginError");
    }
    expect(errors[0].code).toBe("web_target_not_public");
    expect(errors[1].code).toBe("web_target_invalid");
    expect(errors.slice(2).map((error) => error.code)).toEqual(
      Array(3).fill("web_request_aborted"),
    );
  });
});
