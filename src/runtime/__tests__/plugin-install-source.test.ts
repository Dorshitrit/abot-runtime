import { describe, expect, test, vi } from "vitest";
import {
  parsePluginInstallLink,
  parsePluginInstallSource,
} from "../../plugin-contract/install-source.js";
import {
  openPluginInstallLink,
  parsePluginInstallArguments,
  pluginInstallReviewUrl,
} from "../../computer-access/companion/install-link.js";
import { pluginSource } from "./support/plugin-installation-fixture.js";

describe("plugin installation intent", () => {
  test("normalizes public GitHub sources and preserves exact revisions", () => {
    expect(
      parsePluginInstallSource({
        repository: "https://github.com/community/example.git/",
        ref: "v1",
        path: "packages/plugin",
      }),
    ).toEqual({
      repository: pluginSource.repository,
      ref: "v1",
      path: "packages/plugin",
    });
  });
  test.each([
    { repository: "http://github.com/user/repo" },
    { repository: "https://github.com.evil.test/user/repo" },
    { repository: "https://user:secret@github.com/user/repo" },
    { repository: "https://github.com/user/repo/tree/main" },
    { repository: pluginSource.repository, path: "../escape" },
    { repository: pluginSource.repository, path: "/absolute" },
    { repository: pluginSource.repository, ref: "bad\nref" },
  ])("rejects unsupported source %j", (source) =>
    expect(() => parsePluginInstallSource(source)).toThrow(),
  );
  test("handoff selects only the paired Runtime and keeps source fields as data", async () => {
    const link =
      "abot://install?" +
      new URLSearchParams({
        kind: "plugin",
        repo: pluginSource.repository,
        ref: pluginSource.ref,
      });
    expect(parsePluginInstallLink(link)).toEqual(pluginSource);
    const open = vi.fn(async (_url: string) => {});
    const state = {
      read: async () => ({
        version: 1 as const,
        url: "ws://localhost:5177/system/host",
        hostId: "host",
        credential: "secret",
      }),
    };
    await openPluginInstallLink(state, link, open);
    const url = new URL(open.mock.calls[0][0]);
    expect(url.origin).toBe("http://localhost:5177");
    expect(url.pathname).toBe("/plugins");
    expect(url.searchParams.get("pluginSource")).toBe(pluginSource.repository);
    expect(url.toString()).not.toContain("secret");
  });
  test.each([
    "abot://install?kind=studio&repo=https://github.com/a/b",
    "abot://install?kind=plugin&repo=https://github.com/a/b&runtime=http://attacker",
    "abot://install?kind=plugin&repo=https://github.com/a/b&repo=https://github.com/c/d",
    "abot://other?kind=plugin&repo=https://github.com/a/b",
  ])("rejects a forged or unsupported handoff", (link) =>
    expect(() =>
      pluginInstallReviewUrl(link, "http://localhost:5177"),
    ).toThrow(),
  );
  test("unpaired computers cannot forward installation links", async () => {
    const open = vi.fn();
    await expect(
      openPluginInstallLink(
        { read: async () => undefined },
        "abot://install?kind=plugin&repo=https://github.com/a/b",
        open,
      ),
    ).rejects.toThrow("Connect Computer Access");
    expect(open).not.toHaveBeenCalled();
  });
});

test("Windows transport keeps percent sequences literal and rejects injected arguments", () => {
  const link =
    "abot://install?kind=plugin&repo=https%3A%2F%2Fgithub.com%2Fa%2Fb&ref=%25LOCAL_VALUE%25";
  expect(
    parsePluginInstallArguments([
      "--encoded",
      Buffer.from(link).toString("base64"),
    ]),
  ).toBe(link);
  expect(parsePluginInstallArguments([link])).toBe(link);
  expect(() =>
    parsePluginInstallArguments(["--encoded", 'bad"value']),
  ).toThrow();
  expect(() => parsePluginInstallArguments([link, "extra"])).toThrow();
});
