/** Portable installation intent. A source never grants execution authority. */
export type PluginInstallSource = Readonly<{
  repository: string;
  ref?: string;
  path?: string;
}>;

export class PluginInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function invalidSource(message: string): never {
  throw new PluginInstallError("plugin_source_invalid", message);
}

function hasPublicGitHubOrigin(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.hostname !== "github.com") return false;
  if (url.port || url.username || url.password) return false;
  return !url.search && !url.hash;
}

function isPluginInstallEndpoint(url: URL): boolean {
  if (url.protocol !== "abot:") return false;
  if (url.hostname !== "install") return false;
  if (!["", "/"].includes(url.pathname)) return false;
  if (url.username || url.password || url.port) return false;
  return !url.hash;
}

function isRepositoryFolderComponent(part: string): boolean {
  if (part === "." || part === "..") return false;
  return /^[A-Za-z0-9_.-]+$/u.test(part);
}

export function parsePluginInstallSource(input: unknown): PluginInstallSource {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalidSource("Enter a public GitHub repository URL.");
  const value = input as Record<string, unknown>;
  if (typeof value.repository !== "string" || value.repository.length > 512)
    return invalidSource("Enter a public GitHub repository URL.");
  let url: URL;
  try {
    url = new URL(value.repository.trim());
  } catch {
    return invalidSource("Enter a public GitHub repository URL.");
  }
  if (!hasPublicGitHubOrigin(url))
    return invalidSource("Use an HTTPS repository URL on github.com.");
  const match =
    /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/u.exec(
      url.pathname,
    );
  if (!match)
    return invalidSource(
      "Use the repository URL; enter its revision and folder separately.",
    );
  const repo = match[2].replace(/\.git$/u, "");
  if (repo === "." || repo === ".." || !repo)
    return invalidSource("Invalid repository name.");
  const ref = value.ref === undefined ? "" : value.ref;
  if (
    typeof ref !== "string" ||
    ref.length > 200 ||
    /[\u0000-\u0020\u007f\\?#]/u.test(ref)
  )
    return invalidSource("Enter a commit, tag or branch without spaces.");
  const path = value.path === undefined ? "" : value.path;
  if (typeof path !== "string" || path.length > 512)
    return invalidSource("Enter a folder relative to the repository root.");
  if (path && !path.split("/").every(isRepositoryFolderComponent))
    return invalidSource(
      "The plugin folder must be a relative path without traversal.",
    );
  return {
    repository: `https://github.com/${match[1]}/${repo}`,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
  };
}

export function parsePluginInstallLink(value: string): PluginInstallSource {
  if (value.length > 2048)
    return invalidSource("The installation link is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidSource("Invalid ABot installation link.");
  }
  if (!isPluginInstallEndpoint(url))
    return invalidSource("Unsupported ABot installation link.");
  const allowed = ["kind", "repo", "ref", "path"];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      return invalidSource("Unsupported installation link fields.");
  }
  if (url.searchParams.get("kind") !== "plugin")
    return invalidSource("This installation link must select a plugin.");
  return parsePluginInstallSource({
    repository: url.searchParams.get("repo"),
    ref: url.searchParams.get("ref") ?? "",
    path: url.searchParams.get("path") ?? "",
  });
}
