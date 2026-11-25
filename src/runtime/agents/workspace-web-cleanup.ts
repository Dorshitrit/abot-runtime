import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { replacePreparedSessionFile } from "../../sessions/prepared-session-replacement.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { syncAgentStateDirectoryPath } from "./durable-state-file.js";

export type AgentWebCleanupReceipt = Readonly<{ agentId: string; sessionIds: readonly string[] }>;
const receiptName = (id: string) => createHash("sha256").update(id).digest("hex") + ".json";

/** The workspace owner writes one receipt per deleted identity. No conversation content is retained. */
export function createAgentWebCleanup(agentsDirectory: string) {
  const directory = join(agentsDirectory, "web-cleanup");
  async function record(agentId: string, sessionIds: readonly string[]): Promise<void> {
    await ensurePrivateRuntimeDirectory(directory);
    const temp = join(directory, randomUUID() + ".tmp");
    const file = await open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify({ agentId, sessionIds }));
        await file.sync();
      } finally { await file.close(); }
      await replacePreparedSessionFile(temp, join(directory, receiptName(agentId)));
      await syncAgentStateDirectoryPath(directory);
    } finally { await rm(temp, { force: true }); }
  }
  async function pending(): Promise<readonly AgentWebCleanupReceipt[]> {
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    await ensurePrivateRuntimeDirectory(directory);
    const receipts: AgentWebCleanupReceipt[] = [];
    for (const name of entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const path = join(directory, name);
      if (!(await lstat(path)).isFile()) throw new Error("agents_cleanup_receipt_invalid");
      const item = JSON.parse(await readFile(path, "utf8")) as AgentWebCleanupReceipt;
      if (typeof item?.agentId !== "string" || receiptName(item.agentId) !== name ||
        !Array.isArray(item.sessionIds) || !item.sessionIds.every(id => typeof id === "string" && id.length))
        throw new Error("agents_cleanup_receipt_invalid");
      receipts.push(item);
    }
    return receipts;
  }
  return { record, pending, async acknowledge(agentId: string) {
    await rm(join(directory, receiptName(agentId)), { force: true });
    await syncAgentStateDirectoryPath(directory);
  } };
}
