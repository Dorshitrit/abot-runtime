import { realpath } from "node:fs/promises";
import {
  createSetupEditJournal,
  readSetupEditJournal,
  writeSetupEditJournal,
  type SetupEditFilePlan,
} from "./runtime-setup-edit-journal.js";
import {
  requireSetupEditFileSnapshot,
  syncSetupEditFile,
} from "./runtime-setup-edit-files.js";
import {
  reconcileSetupEditJournal,
  requireRuntimeSetupEditSettled,
} from "./runtime-setup-edit-recovery.js";

/** Setup, config, model and credential locks enclose this complete transaction. */
export async function commitRuntimeSetupEdit(
  rootDir: string,
  files: readonly SetupEditFilePlan[],
  commit: () => Promise<void>,
  publishCommittedCredentials: () => void,
): Promise<void> {
  const root = await realpath(rootDir);
  requireRuntimeSetupEditSettled(root);
  const journal = await createSetupEditJournal(root, files);
  await writeSetupEditJournal(journal);
  try {
    await commit();
    for (const file of journal.files) {
      await requireSetupEditFileSnapshot(file.path, file.after);
      await syncSetupEditFile(file.path);
    }
    await writeSetupEditJournal({ ...journal, phase: "committed" }, journal);
  } catch (error) {
    try {
      const persisted = await readSetupEditJournal(root);
      if (persisted?.phase === "committed") publishCommittedCredentials();
      if (persisted) await reconcileSetupEditJournal(persisted);
      if (persisted?.phase === "committed") return;
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Connection edit failed and needs recovery before it can be applied.",
      );
    }
    throw error;
  }
  publishCommittedCredentials();
  // A cleanup failure leaves a committed marker. Never roll it back.
  await reconcileSetupEditJournal({ ...journal, phase: "committed" });
}
