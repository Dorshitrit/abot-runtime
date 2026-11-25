import { win32 } from "node:path";
import { requireValue } from "./contracts.js";

export function windowsSystemRoot(source: NodeJS.ProcessEnv = process.env): string {
  const root = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  requireValue(/^[A-Za-z]:\\[^\r\n\0]*$/u.test(root), "unsupported_platform", "Invalid Windows system directory.");
  return root;
}

/** Explicit child environment: no inherited credentials, loaders or model flags. */
export function llamaProcessEnvironment(token: string, os: string = process.platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (os === "win32") {
    const SystemRoot = windowsSystemRoot(source);
    return { SystemRoot, PATH: win32.join(SystemRoot, "System32"), LLAMA_API_KEY: token };
  }
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", LLAMA_API_KEY: token };
}
