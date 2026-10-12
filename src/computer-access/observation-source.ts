export type RuntimeCollectionSource = Readonly<{
  mode: "native" | "companion";
  platform: "windows" | "macos" | "linux" | "unsupported";
}>;

/** The Runtime process selects the source; the browser and paired computer do not. */
export function readRuntimeCollectionSource(
  platform: NodeJS.Platform = process.platform,
): RuntimeCollectionSource {
  if (platform === "win32") return { mode: "native", platform: "windows" };
  if (platform === "darwin") return { mode: "companion", platform: "macos" };
  if (platform === "linux") return { mode: "companion", platform: "linux" };
  return { mode: "companion", platform: "unsupported" };
}
