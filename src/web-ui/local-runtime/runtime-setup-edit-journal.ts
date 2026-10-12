import { parse } from "dotenv";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../runtime/config/utils.js";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import {
  readSetupEditFile,
  setupEditRecoveryRequired,
  setupEditSnapshotText,
  setupEditTextSnapshot,
  publishSetupEditJournal,
  type SetupEditFileSnapshot,
} from "./runtime-setup-edit-files.js";

export const SETUP_EDIT_JOURNAL_NAME = ".runtime-setup-edit.json";
const FILE_ROLES = ["model", "config", "receipt", "credentials"] as const;
type SetupEditFileRole = (typeof FILE_ROLES)[number];
export type SetupEditJournalFile = Readonly<{
  role: SetupEditFileRole;
  path: string;
  before: SetupEditFileSnapshot;
  after: SetupEditFileSnapshot;
}>;
export type SetupEditJournal = Readonly<{
  version: 1;
  id: string;
  rootDir: string;
  phase: "pending" | "committed";
  files: readonly SetupEditJournalFile[];
}>;
export type SetupEditFilePlan = Readonly<{
  role: SetupEditFileRole;
  path: string;
  text: string;
  mode?: number;
}>;

export function setupEditJournalPath(rootDir: string): string {
  return join(rootDir, SETUP_EDIT_JOURNAL_NAME);
}

function isSetupEditSnapshot(value: unknown): value is SetupEditFileSnapshot {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.mode)) return false;
  if (typeof value.mode !== "number" || value.mode < 0 || value.mode > 0o777)
    return false;
  if (value.bytes === null) return value.mode === 0;
  if (typeof value.bytes !== "string") return false;
  return Buffer.from(value.bytes, "base64").toString("base64") === value.bytes;
}

function isSetupEditJournalFile(
  value: unknown,
  index: number,
): value is SetupEditJournalFile {
  if (!isRecord(value)) return false;
  if (value.role !== FILE_ROLES[index]) return false;
  if (typeof value.path !== "string" || value.path !== resolve(value.path))
    return false;
  if (!isSetupEditSnapshot(value.before)) return false;
  if (!isSetupEditSnapshot(value.after)) return false;
  if (value.after.bytes === null) return false;
  if (value.role !== "credentials" && value.before.bytes === null) return false;
  return true;
}

function parseSetupEditObject(
  snapshot: SetupEditFileSnapshot,
): Record<string, unknown> {
  const value: unknown = JSON.parse(setupEditSnapshotText(snapshot));
  if (!isRecord(value)) throw setupEditRecoveryRequired();
  return value;
}

async function requireSetupEditFileBindings(
  journal: SetupEditJournal,
): Promise<void> {
  const [model, config, receipt, credentials] = journal.files;
  if (receipt.path !== config.path + ".web-setup.json")
    throw setupEditRecoveryRequired();
  if (credentials.path !== join(journal.rootDir, ".env"))
    throw setupEditRecoveryRequired();
  if (
    new Set(journal.files.map((file) => file.path)).size !== FILE_ROLES.length
  )
    throw setupEditRecoveryRequired();
  for (const state of ["before", "after"] as const) {
    const draft = parseSetupEditObject(receipt[state]);
    if (draft.version !== 1 || typeof draft.revision !== "string")
      throw setupEditRecoveryRequired();
    if (draft.configPath !== config.path || draft.modelPath !== model.path)
      throw setupEditRecoveryRequired();
    if (
      !isDeepStrictEqual(draft.modelConfig, parseSetupEditObject(model[state]))
    )
      throw setupEditRecoveryRequired();
    const saved = parseSetupEditObject(config[state]);
    const models = isRecord(saved.models) ? saved.models : {};
    const profiles = isRecord(models.profiles) ? models.profiles : {};
    if (!isDeepStrictEqual(draft.profileReferences, profiles))
      throw setupEditRecoveryRequired();
    if (!isRecord(draft.ownedProviders)) throw setupEditRecoveryRequired();
    const providers = isRecord(models.providers) ? models.providers : {};
    for (const [id, provider] of Object.entries(draft.ownedProviders)) {
      if (!isDeepStrictEqual(providers[id], provider))
        throw setupEditRecoveryRequired();
    }
    const profile = isRecord(profiles.default) ? profiles.default : {};
    if (typeof profile.configRef !== "string")
      throw setupEditRecoveryRequired();
    const referenced = await canonicalConfigFilePath(
      resolve(dirname(config.path), profile.configRef),
    );
    if (referenced !== model.path) throw setupEditRecoveryRequired();
  }
  const env = parse(setupEditSnapshotText(credentials.after));
  if (typeof env.LLM_RUNTIME_CONFIG_FILE !== "string")
    throw setupEditRecoveryRequired();
  const configured = await canonicalConfigFilePath(
    resolve(journal.rootDir, env.LLM_RUNTIME_CONFIG_FILE),
  );
  if (configured !== config.path) throw setupEditRecoveryRequired();
}

export async function validateSetupEditJournal(
  value: unknown,
  rootDir: string,
): Promise<SetupEditJournal> {
  try {
    if (!isRecord(value)) throw setupEditRecoveryRequired();
    if (value.version !== 1 || typeof value.id !== "string")
      throw setupEditRecoveryRequired();
    if (value.rootDir !== rootDir) throw setupEditRecoveryRequired();
    if (value.phase !== "pending" && value.phase !== "committed")
      throw setupEditRecoveryRequired();
    if (!Array.isArray(value.files) || value.files.length !== FILE_ROLES.length)
      throw setupEditRecoveryRequired();
    if (!value.files.every(isSetupEditJournalFile))
      throw setupEditRecoveryRequired();
    const journal = value as SetupEditJournal;
    await requireSetupEditFileBindings(journal);
    return journal;
  } catch {
    throw setupEditRecoveryRequired();
  }
}

export async function readSetupEditJournal(
  rootDir: string,
): Promise<SetupEditJournal | undefined> {
  const snapshot = await readSetupEditFile(setupEditJournalPath(rootDir));
  if (snapshot.bytes === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(setupEditSnapshotText(snapshot));
  } catch {
    throw setupEditRecoveryRequired();
  }
  return validateSetupEditJournal(value, rootDir);
}

export async function createSetupEditJournal(
  rootDir: string,
  plans: readonly SetupEditFilePlan[],
): Promise<SetupEditJournal> {
  const files: SetupEditJournalFile[] = [];
  for (const plan of plans) {
    const before = await readSetupEditFile(plan.path);
    files.push({
      role: plan.role,
      path: plan.path,
      before,
      after: setupEditTextSnapshot(plan.text, plan.mode ?? before.mode),
    });
  }
  return validateSetupEditJournal(
    {
      version: 1,
      id: randomUUID(),
      rootDir,
      phase: "pending",
      files,
    },
    rootDir,
  );
}

export async function writeSetupEditJournal(
  journal: SetupEditJournal,
  previous?: SetupEditJournal,
): Promise<void> {
  const path = setupEditJournalPath(journal.rootDir);
  const expected = previous
    ? setupEditTextSnapshot(JSON.stringify(previous) + "\n", 0o600)
    : { bytes: null, mode: 0 };
  await publishSetupEditJournal(path, JSON.stringify(journal) + "\n", expected);
}
