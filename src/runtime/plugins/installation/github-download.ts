import {
  PluginInstallError,
  parsePluginInstallSource,
  type PluginInstallSource,
} from "../../../plugin-contract/install-source.js";

export type PluginDownload = Readonly<{
  source: PluginInstallSource & { ref: string };
  archive: Buffer;
}>;
export type PluginSourceFetcher = (
  input: PluginInstallSource,
) => Promise<PluginDownload>;
const ARCHIVE_LIMIT = 25 * 1024 * 1024;

async function readBoundedResponse(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new PluginInstallError(
      "plugin_download_failed",
      "GitHub could not provide this public repository or revision.",
      502,
    );
  }
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    await response.body?.cancel();
    throw new PluginInstallError(
      "plugin_download_limit",
      "The repository archive is too large.",
    );
  }
  if (!response.body)
    throw new PluginInstallError(
      "plugin_download_failed",
      "GitHub returned no content.",
      502,
    );
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum)
        throw new PluginInstallError(
          "plugin_download_limit",
          "The repository archive is too large.",
        );
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const downloadGitHubPlugin: PluginSourceFetcher = async (input) => {
  const source = parsePluginInstallSource(input);
  const repository = new URL(source.repository).pathname.slice(1);
  const signal = AbortSignal.timeout(60_000);
  try {
    let ref = source.ref;
    if (!ref) {
      const response = await fetch(
        `https://api.github.com/repos/${repository}`,
        {
          headers: { accept: "application/vnd.github+json" },
          redirect: "error",
          signal,
        },
      );
      const metadata = JSON.parse(
        (await readBoundedResponse(response, 256 * 1024)).toString("utf8"),
      ) as { default_branch?: unknown };
      if (typeof metadata.default_branch !== "string")
        throw new Error("missing_branch");
      ref = metadata.default_branch;
    }
    const response = await fetch(
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
      {
        headers: { accept: "application/vnd.github+json" },
        redirect: "error",
        signal,
      },
    );
    const commit = JSON.parse(
      (await readBoundedResponse(response, 2 * 1024 * 1024)).toString("utf8"),
    ) as { sha?: unknown };
    if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/u.test(commit.sha))
      throw new Error("invalid_commit");
    if (/^[a-f0-9]{40}$/u.test(ref) && commit.sha !== ref)
      throw new Error("commit_mismatch");
    const archiveResponse = await fetch(
      `https://codeload.github.com/${repository}/zip/${commit.sha}`,
      { redirect: "error", signal },
    );
    return {
      source: { ...source, ref: commit.sha },
      archive: await readBoundedResponse(archiveResponse, ARCHIVE_LIMIT),
    };
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError(
      "plugin_download_failed",
      "The GitHub download failed or timed out. Check the repository and revision.",
      502,
    );
  }
};
