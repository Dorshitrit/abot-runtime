import { randomBytes } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateManagedDirectory } from "../../host-files.js";
import type { ServerSettings } from "../settings.js";

export async function privateRoot() {
  const root = join(await realpath(tmpdir()), "llama-server-test-" + randomBytes(8).toString("hex"));
  await createPrivateManagedDirectory(root);
  return root;
}
export const serverSettings = (root: string): ServerSettings => ({ startup: "manual", port: 18080,
  sleepIdleSeconds: 60, maxLoadedModels: 2,
  models: [{ alias: "chat:one", modelPath: join(root, "chat.gguf"), contextTokens: 4096, gpuLayers: 0 }], embedding: null });
export function ggufBytes(fields: Array<[string, string | number]>) {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(fields.length),
    ...fields.flatMap(([key, value]) => [str(key), u32(typeof value === "string" ? 8 : 4), typeof value === "string" ? str(value) : u32(value)])]);
}
export async function writeGguf(path: string, extra: Array<[string, string | number]> = []) {
  await writeFile(path, ggufBytes([["general.architecture", "llama"], ["llama.context_length", 32768],
    ["tokenizer.chat_template", "{{ messages }}"], ...extra]));
}
