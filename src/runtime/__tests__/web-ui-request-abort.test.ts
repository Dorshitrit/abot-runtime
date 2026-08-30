import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test } from "vitest";

import { withHttpRequestAbortSignal } from "../../web-ui/local-runtime/request-abort.js";

describe("HTTP request abort scope", () => {
  test("aborts provider work when the response connection closes", async () => {
    const request = createRequest();
    const response = createResponse();
    const operation = withHttpRequestAbortSignal({
      request,
      response,
      reason: "fixture_aborted",
      run: (abortSignal) =>
        new Promise<AbortSignal>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(abortSignal), {
            once: true,
          });
        }),
    });

    response.emit("close");

    await expect(operation).resolves.toMatchObject({ aborted: true });
  });

  test("removes connection listeners after normal completion", async () => {
    const request = createRequest();
    const response = createResponse();

    await expect(
      withHttpRequestAbortSignal({
        request,
        response,
        reason: "fixture_aborted",
        run: async () => "completed",
      }),
    ).resolves.toBe("completed");

    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });
});

function createRequest(): IncomingMessage {
  return Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
}

function createResponse(): ServerResponse & EventEmitter {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse & EventEmitter;
}
