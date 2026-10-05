import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileSessionStore } from "../../adapters/file-session-store.js";
import { createFileAttachmentStore } from "../../attachments/store.js";
import { SessionRequestAdmission } from "../../request/session-admission.js";
import { createSessionLifecycleStore } from "../../session/session-lifecycle-store.js";
import { createSparkSessionClearBoundary } from "../../session/spark-session-clear.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../../sessions/spark-session.js";

export function createSparkClearGate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { open, waiting };
}

/** File-backed owner fixture, without a request kernel, model or background clock. */
export async function createSparkClearFixture() {
  const parent = join(process.cwd(), ".codex/artifacts/spark-clear-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  const attachments = createFileAttachmentStore({ attachmentsDir: join(directory, "attachments") });
  function createOwner() {
    const backing = createFileSessionStore({ sessionsDir: join(directory, "sessions") });
    const admission = new SessionRequestAdmission(() => false,
      async (id) => Boolean((await backing.requestLifecycle!.listWaiting(id)).length));
    const clear = createSparkSessionClearBoundary(backing, () => admission, attachments, directory);
    const sessions = createSessionLifecycleStore(backing, undefined, undefined, clear).store;
    return { backing, admission, sessions };
  }
  const owner = createOwner();
  await ensureSparkSession(owner.sessions);
  return {
    ...owner, directory, attachments, restart: createOwner,
    receiptPath: join(directory, "spark-chat", "attachment-cleanup.json"),
    async attach(requestId = "upload") {
      const reference = await attachments.saveAttachment({ sessionId: SPARK_SESSION_ID, requestId,
        kind: "file", mimeType: "text/plain", bytes: Buffer.from(requestId) });
      await owner.sessions.appendMessage(SPARK_SESSION_ID, "user", "Read this", { attachments: [reference] });
      return reference;
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
