import { describe, expect, test } from "vitest";

import { EmbeddingProviderRequestError } from "../embeddings/execution.js";
import type { GatewayResponse } from "./contracts.js";
import { respondToGatewayHandlerError } from "./errors.js";

describe("model gateway error responses", () => {
  test.each([401, 429, 503])(
    "preserves embedding provider status %i",
    (statusCode) => {
      const response = createCaptureResponse();

      respondToGatewayHandlerError({
        error: new EmbeddingProviderRequestError(
          statusCode,
          "embedding provider error",
        ),
        response,
        abortSignal: new AbortController().signal,
        includeContextWindowErrors: false,
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.body).toBe("embedding provider error");
    },
  );
});

function createCaptureResponse(): GatewayResponse & { body: string } {
  return {
    body: "",
    setHeader() {},
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}
