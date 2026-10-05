import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ExecPluginError } from "./errors.js";
import type {
  ExecOutputBody,
  ExecOutputOwnerRecord,
  ExecOutputSnapshotRecord,
} from "./output-contracts.js";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function outputStorageRoot(stateDir: string): string {
  if (!stateDir.trim()) throw outputFailure("state_dir_invalid");
  return resolve(stateDir, "output");
}
export function outputOwnerDirectory(root: string, ownerId: string): string {
  if (!ownerId.trim()) throw outputFailure("owner_invalid");
  return join(root, createHash("sha256").update(ownerId).digest("hex"));
}
export function outputStreamPath(directory: string, id: string): string {
  assertOutputId(id);
  return join(directory, `${id}.bytes`);
}
export function outputSnapshotPath(directory: string, id: string): string {
  assertOutputId(id);
  return join(directory, `${id}.snapshot.json`);
}
export function assertOutputId(id: string): void {
  if (typeof id !== "string" || !ID.test(id)) throw outputFailure("id_invalid");
}
export function outputFailure(code: string, cause?: unknown): ExecPluginError {
  const error = new ExecPluginError(
    `exec_output_${code}`,
    `Exec output storage failed: ${code}.`,
  );
  if (cause !== undefined)
    Object.defineProperty(error, "cause", { value: cause });
  return error;
}
export async function writeOutputMetadata(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw outputFailure("metadata_write_failed", error);
  }
}
export async function prepareOutputOwnerDirectory(
  directory: string,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw outputFailure("write_failed", error);
  }
}
export async function readOutputOwner(
  directory: string,
): Promise<ExecOutputOwnerRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw outputFailure("owner_read_failed", error);
  }
  if (!isOutputOwnerRecord(value)) throw outputFailure("owner_invalid");
  return value;
}
function isOutputOwnerRecord(value: unknown): value is ExecOutputOwnerRecord {
  if (!value || typeof value !== "object") return false;
  const owner = value as ExecOutputOwnerRecord;
  if (owner.kind !== "exec_output_owner_v1") return false;
  if (typeof owner.ownerId !== "string" || !owner.ownerId.trim()) return false;
  return (
    owner.completedAt === null ||
    (Number.isSafeInteger(owner.completedAt) && owner.completedAt >= 0)
  );
}
export async function lookupOutputSnapshot(
  directory: string,
  ownerId: string,
  id: string,
): Promise<ExecOutputSnapshotRecord> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(outputSnapshotPath(directory, id), "utf8"),
    );
  } catch (error) {
    throw outputFailure("snapshot_unavailable", error);
  }
  if (!isStoredOutputSnapshot(value, ownerId, id))
    throw outputFailure("snapshot_binding_invalid");
  return value;
}
function isStoredOutputSnapshot(
  value: unknown,
  ownerId: string,
  id: string,
): value is ExecOutputSnapshotRecord {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as ExecOutputSnapshotRecord;
  if (
    snapshot.kind !== "exec_output_snapshot_v1" ||
    snapshot.ownerId !== ownerId
  )
    return false;
  if (typeof snapshot.streamId !== "string" || !ID.test(snapshot.streamId))
    return false;
  const body = snapshot.body;
  if (!body || typeof body !== "object" || body.id !== id) return false;
  return isExecOutputBody(body);
}
export function isExecOutputBody(value: unknown): value is ExecOutputBody {
  if (!value || typeof value !== "object") return false;
  const body = value as ExecOutputBody;
  if (typeof body.id !== "string" || !ID.test(body.id)) return false;
  if (body.stream !== "stdout" && body.stream !== "stderr") return false;
  if (!Number.isSafeInteger(body.startByte) || body.startByte < 0) return false;
  if (!Number.isSafeInteger(body.endByte) || body.endByte < body.startByte)
    return false;
  if (body.byteLength !== body.endByte - body.startByte) return false;
  return (
    typeof body.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(body.sha256)
  );
}
export async function readOutputSnapshot(
  directory: string,
  ownerId: string,
  body: ExecOutputBody,
): Promise<ExecOutputSnapshotRecord> {
  const snapshot = await lookupOutputSnapshot(directory, ownerId, body.id);
  const stored = snapshot.body;
  if (
    stored.stream !== body.stream ||
    stored.startByte !== body.startByte ||
    stored.endByte !== body.endByte ||
    stored.byteLength !== body.byteLength ||
    stored.sha256 !== body.sha256
  )
    throw outputFailure("snapshot_binding_invalid");
  return snapshot;
}
