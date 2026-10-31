import { describe, expect, it } from "vitest";
import { get } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createChatGptCallback } from "../callback.js";

describe("dedicated ChatGPT loopback callback", () => {
  it("rejects malformed raw targets without losing the listener or consuming callback state", async () => {
    const fixture = fileURLToPath(new URL("./callback-malformed-target-process.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--unhandled-rejections=strict", "--import", "tsx", fixture],
      { timeout: 5000, maxBuffer: 32 * 1024, windowsHide: true },
    );
    const result = JSON.parse(stdout);
    expect(result.malformed.status).toBe(400);
    expect(result.malformed.body.length).toBeLessThan(256);
    expect(result.malformed.body).not.toContain("CALLBACK_RAW_SECRET");
    expect(result.malformed.cacheControl).toBe("no-store");
    expect(result.malformed.contentType).toBe("text/plain; charset=utf-8");
    expect(result.valid.status).toBe(200);
    expect(result.received).toEqual([{ state: "expected-state", code: "valid-code" }]);
  });


  it("accepts only its exact local host/path and never renders callback values", async () => {
    const received: URLSearchParams[] = [];
    const callback = await createChatGptCallback(async (parameters) => {
      received.push(parameters);
    });
    try {
      const response = await fetch(
        callback.redirectUri + "?state=state&code=SECRET",
      );
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("SECRET");
      expect(received[0]?.get("code")).toBe("SECRET");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const forgedStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = get(
            callback.redirectUri,
            { headers: { host: "evil.example" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.once("error", reject);
        },
      );
      expect(forgedStatus).toBe(400);
      expect(
        (await fetch(callback.redirectUri + "?state=a&state=b")).status,
      ).toBe(400);
      expect(
        (
          await fetch(
            callback.redirectUri.replace("/auth/callback", "/callback"),
          )
        ).status,
      ).toBe(404);
      expect(
        (await fetch(callback.redirectUri, { method: "POST" })).status,
      ).toBe(400);
      expect(received).toHaveLength(1);
    } finally {
      callback.close();
    }
  });
});
