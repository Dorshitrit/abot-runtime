import type { AutomationPersistence } from "./persistence.js";
import { readAutomationSnapshotPreparationOwners } from "./snapshot-staging.js";

/** Called after attachment-directory inventory. A removed marker's committed claim is read last. */
export async function listAutomationAttachmentOwners(options: {
  runtimeDir: string;
  persistence: Pick<AutomationPersistence, "read">;
}): Promise<string[]> {
  const owners = new Set(await readAutomationSnapshotPreparationOwners(options.runtimeDir));
  const state = await options.persistence.read();
  for (const execution of state.executions) owners.add(execution.id);
  for (const input of state.inputs) {
    if (!input.snapshot) continue;
    const owner = input.snapshot.attachment.storageRef.split(/[\\/]/u)[0];
    if (!owner) throw new Error("automation_snapshot_owner_invalid");
    owners.add(owner);
  }
  return [...owners];
}
