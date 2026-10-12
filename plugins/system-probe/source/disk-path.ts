/** The Windows default follows the runtime root's actual filesystem volume. */
export function defaultDiskProbePath(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return runtimeRoot;
  return "/";
}
