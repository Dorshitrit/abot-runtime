import { afterEach, expect, test, vi } from "vitest";
import { downloadGitHubPlugin } from "../plugins/installation/github-download.js";
import { pluginSource } from "./support/plugin-installation-fixture.js";
afterEach(() => vi.unstubAllGlobals());

test("a repository URL resolves its default branch and downloads only the resulting immutable commit", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "release/current" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ sha: pluginSource.ref })))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", fetcher);
  const result = await downloadGitHubPlugin({ repository: pluginSource.repository });
  expect(result.source).toEqual(pluginSource);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/community/example",
    "https://api.github.com/repos/community/example/commits/release%2Fcurrent",
    "https://codeload.github.com/community/example/zip/" + pluginSource.ref,
  ]);
  for (const [, options] of fetcher.mock.calls) expect(options.redirect).toBe("error");
});

test("an exact commit mismatch is rejected before fetching an archive", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ sha: "b".repeat(40) })));
  vi.stubGlobal("fetch", fetcher);
  await expect(downloadGitHubPlugin(pluginSource)).rejects.toMatchObject({ code: "plugin_download_failed" });
  expect(fetcher).toHaveBeenCalledOnce();
});

test("an oversized archive is refused without consuming its body", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ cancel });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ sha: pluginSource.ref })))
    .mockResolvedValueOnce(new Response(stream, { headers: { "content-length": String(26 * 1024 * 1024) } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(downloadGitHubPlugin(pluginSource)).rejects.toMatchObject({ code: "plugin_download_limit" });
  expect(cancel).toHaveBeenCalledOnce();
});
