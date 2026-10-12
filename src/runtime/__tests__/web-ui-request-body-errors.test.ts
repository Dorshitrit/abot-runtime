import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import {
  createInputValidationFixture,
  inputFixtureFileHashes,
  type InputValidationFixture,
} from "./support/input-validation-fixture.js";

let fixture: InputValidationFixture;
beforeEach(async () => {
  fixture = await createInputValidationFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("shared HTTP request body errors", () => {
  test.each([
    ["PUT", "runtime/config/dashboard/file", "{", "invalid_json"],
    ["POST", "chat/sessions/page", "[]", "json_object_required"],
  ])(
    "classifies the exact %s %s malformed body as 400 without writes",
    async (method, route, body, code) => {
      const before = await inputFixtureFileHashes(fixture.rootDir);
      const response = await fixture.request(method, route, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: code });
      expect(await inputFixtureFileHashes(fixture.rootDir)).toEqual(before);
      const healthy = await fixture.request("GET", "health");
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toMatchObject({
        ok: true,
        activeStreamingRequests: 0,
      });
    },
  );

  test("does not echo malformed body fragments", async () => {
    const response = await fixture.request(
      "PUT",
      "runtime/config/dashboard/file",
      '{"secret":"synthetic-private-key",',
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("synthetic-private-key");
  });

  test("preserves configuration origin and content-type checks before parsing", async () => {
    const before = await inputFixtureFileHashes(fixture.rootDir);
    expect(
      (
        await fixture.request("PUT", "runtime/config/dashboard/file", "{", {
          origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.request("PUT", "runtime/config/dashboard/file", "{", {
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(await inputFixtureFileHashes(fixture.rootDir)).toEqual(before);
  });

  test("still accepts a valid configuration save after rejecting malformed JSON", async () => {
    expect(
      (await fixture.request("PUT", "runtime/config/dashboard/file", "{"))
        .status,
    ).toBe(400);
    const current = (
      await (await fixture.request("GET", "runtime/config/dashboard")).json()
    ).dashboard.files.runtime;
    const response = await fixture.request(
      "PUT",
      "runtime/config/dashboard/file",
      JSON.stringify({
        kind: "runtime",
        expectedRevision: current.revision,
        config: {
          ...current.config,
          webUi: { openOnRuntimeServiceStart: true },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await fixture.readConfig()).webUi.openOnRuntimeServiceStart).toBe(
      true,
    );
  });

  test.each([Error, SyntaxError])(
    "keeps unexpected backend %s errors as 500",
    async (ErrorType) => {
      vi.spyOn(dashboard, "getConfigDashboardSnapshot").mockRejectedValueOnce(
        new ErrorType("synthetic unexpected backend failure"),
      );
      const response = await fixture.request("GET", "runtime/config/dashboard");
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "local_runtime_backend_error",
      });
      expect((await fixture.request("GET", "health")).status).toBe(200);
    },
  );
});
