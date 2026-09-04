import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { createPackedWebSearchProbe } from "../../../scripts/packed-web-search-probe.js";

function runFailingProbe(executeBody: string): string {
  const source = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const dns = require("node:dns/promises");
    const http = require("node:http");
    const https = require("node:https");
    const net = require("node:net");
    const original = [dns.lookup, http.request, https.request,
      net.Socket.prototype.connect, globalThis.fetch];
    const toolRegistry = { execute: async () => { ${executeBody} } };
    let failure;
    try {
      ${createPackedWebSearchProbe(["https://example.com"])}
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the probe must reject this invocation");
    assert.deepEqual([dns.lookup, http.request, https.request,
      net.Socket.prototype.connect, globalThis.fetch], original);
    process.stdout.write(failure.message);
  `;
  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

describe("packed Web search transport fixture", () => {
  test("loads the external parser through CommonJS on the consumer Node runtime", () => {
    const source = `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
      assert.equal(manifest.dependencies.htmlparser2, "10.0.0");
      const parser = require("htmlparser2");
      const document = parser.parseDocument(
        "<rss><channel><title>Fixture</title></channel></rss>", { xmlMode: true },
      );
      assert.equal(document.children[0].name, "rss");
      process.stdout.write("CommonJS parser dependency passed");
    `;
    const output = execFileSync(process.execPath, ["--eval", source], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toBe("CommonJS parser dependency passed");
  });

  test("runs the offline packed probe against the real source plugin", () => {
    const pluginUrl = pathToFileURL(
      resolve("plugins/web/source/plugin.ts"),
    ).href;
    const source = `
      import { createWebPlugin } from ${JSON.stringify(pluginUrl)};
      const plugin = createWebPlugin({ config: {}, secrets: { get: () => undefined } });
      const toolRegistry = {
        execute: ({ tool, params }) => plugin.handlers[tool](params),
      };
      ${createPackedWebSearchProbe()}
      process.stdout.write("offline Light source probe passed");
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        encoding: "utf8",
        timeout: 35_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toBe("offline Light source probe passed");
  }, 40_000);

  test("restores native exports and global fetch after a plugin failure", () => {
    expect(runFailingProbe('throw new Error("plugin fixture failure");')).toBe(
      "plugin fixture failure",
    );
  });

  test("rejects unexpected content origins before any HTTP request", () => {
    const message = runFailingProbe(`
      https.request({
        protocol: "https:", hostname: "outside.example", path: "/",
      }, () => undefined);
    `);
    expect(message).toBe(
      "packed Light attempted an unexpected origin: https://outside.example",
    );
  });

  test("rejects socket and fetch bypasses of the fixture transport", () => {
    expect(
      runFailingProbe("new net.Socket().connect(443, 'example.com');"),
    ).toBe("packed Light must not open a network socket");
    expect(runFailingProbe("await fetch('https://example.com');")).toBe(
      "packed Light bypassed the public HTTP transport",
    );
  });
});
