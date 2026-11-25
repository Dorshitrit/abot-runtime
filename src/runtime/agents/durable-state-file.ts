import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replacePreparedSessionFile } from "../../sessions/prepared-session-replacement.js";
import { AgentStateError } from "./state-error.js";
import type { AgentState } from "./agent-records.js";

/** The new bytes are visible, but their durable publication was not confirmed. */
export class AgentStateCommitUnknownError extends AgentStateError {
  constructor(
    readonly targetRevision: number,
    cause: unknown,
  ) {
    super("agents_commit_outcome_unknown", { cause });
    this.name = "AgentStateCommitUnknownError";
  }
}

async function syncAgentStateDirectory(directory: string): Promise<void> {
  // Node cannot fsync Windows directories. File sync and atomic replacement
  // still apply there; power-loss durability remains platform-specific.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

/** Also establish directory entries left by a newly created or crashed owner. */
export async function syncAgentStateDirectoryPath(
  directory: string,
): Promise<void> {
  if (process.platform === "win32") return;
  let current = resolve(directory);
  for (;;) {
    await syncAgentStateDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Caller owns the store lock; only this invocation's temporary file is cleaned. */
export async function writeDurableAgentState(
  filename: string,
  state: AgentState,
): Promise<void> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let replaced = false;
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
    await replacePreparedSessionFile(temporary, filename);
    ownsTemporary = false;
    replaced = true;
    await syncAgentStateDirectory(dirname(filename));
  } catch (error) {
    if (ownsTemporary)
      await rm(temporary, { force: true }).catch(() => undefined);
    if (replaced) throw new AgentStateCommitUnknownError(state.revision, error);
    throw error;
  }
}
