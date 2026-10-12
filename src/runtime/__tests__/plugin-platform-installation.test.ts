import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectPluginPackage } from "../plugins/installation/service.js";
import {
  communityArchive,
  communityManifest,
  pluginSource,
  sourceFetcher,
} from "./support/plugin-installation-fixture.js";
// @ts-expect-error Browser module.
import { renderPluginDiscovery } from "../../web-ui/app/components/plugins/discovery-rendering.js";
// @ts-expect-error Browser module.
import { pluginInstallationMessage } from "../../web-ui/app/components/plugins/installation-compatibility.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function inspectPlatformPackage(declared: boolean) {
  const parent = join(
    process.cwd(),
    ".codex/artifacts/windows-ci-plugin-compatibility/install-tests",
  );
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "review-"));
  roots.push(root);
  const manifest = communityManifest();
  if (declared)
    Object.assign(manifest.extensions, {
      "ai.abot.compatibility": { version: 1, runtimePlatforms: ["linux"] },
    });
  const archive = await communityArchive({
    manifest,
    code: 'throw new Error("review must never execute plugin code");',
  });
  return inspectPluginPackage(root, pluginSource, sourceFetcher(archive));
}

test("installation review exposes an incompatible declaration without executing code", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const review = await inspectPlatformPackage(true);
  expect(review.compatibility).toMatchObject({
    supported: false,
    status: "unsupported",
    runtimePlatform: "win32",
  });
  expect(review.source).toEqual(pluginSource);
  expect(review.digest).toMatch(/^[a-f0-9]{64}$/u);
  const html = renderPluginDiscovery({
    source: review.source,
    review,
    busy: false,
    error: "",
    message: "",
  });
  expect(html.match(/data-plugin-install-confirm/g)).toHaveLength(2);
  expect(html).not.toContain("Install and enable");
  expect(html).toContain("Unavailable");
  expect(html).not.toContain("data-plugin-install-confirm disabled");
  expect(pluginInstallationMessage(review)).not.toContain(
    "Apply changes to make it available",
  );
});

test("legacy package review explains why native Windows cannot load it", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const review = await inspectPlatformPackage(false);
  expect(review.compatibility).toMatchObject({
    supported: false,
    status: "undeclared",
  });
});

test("compatible package review keeps existing installation semantics", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const review = await inspectPlatformPackage(true);
  expect(review.compatibility).toMatchObject({
    supported: true,
    status: "declared",
  });
  const html = renderPluginDiscovery({
    source: review.source,
    review,
    busy: false,
    error: "",
    message: "",
  });
  expect(html).toContain("Install and enable");
  expect(html).not.toContain("Unavailable on");
  expect(pluginInstallationMessage(review)).toContain("Apply changes");
});
