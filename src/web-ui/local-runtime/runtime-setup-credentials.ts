import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import { parse } from "dotenv";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import { replaceRuntimeSetupEnvironmentAssignment } from "./runtime-setup-environment-assignment.js";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type CredentialFileSnapshot = { raw?: string; mode: number };
type RuntimeSetupCredentialWrite = {
  rootDir: string;
  configPath: string;
  apiKey?: string;
  apiKeyEnv?: string;
  preserveExistingCredential?: boolean;
};

async function readCredentialFileSnapshot(
  rootDir: string,
): Promise<CredentialFileSnapshot> {
  const path = join(rootDir, ".env");
  try {
    const info = await lstat(path);
    const isRegularCredentialFile = info.isFile() && !info.isSymbolicLink();
    if (!isRegularCredentialFile)
      throw new RuntimeSetupError(
        "unsafe_credential_file",
        "The local credential file must be a regular file.",
        409,
      );
    return { raw: await readFile(path, "utf8"), mode: info.mode & 0o777 };
  } catch (error) {
    if (isMissingFile(error)) return { mode: 0o600 };
    throw error;
  }
}

async function readCredentialFile(rootDir: string): Promise<string> {
  return (await readCredentialFileSnapshot(rootDir)).raw ?? "";
}

async function requireUnchangedCredentialFile(
  rootDir: string,
  expected: string | undefined,
): Promise<void> {
  const current = await readCredentialFileSnapshot(rootDir);
  if (current.raw === expected) return;
  throw new RuntimeSetupError(
    "setup_credentials_changed",
    "Credentials changed while setup was being saved. Try again.",
    409,
  );
}

async function replaceCredentialFile(
  rootDir: string,
  previous: string | undefined,
  next: string,
  mode = 0o600,
): Promise<void> {
  const path = join(rootDir, ".env");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: "utf8", mode, flag: "wx" });
    await chmod(temporary, mode);
    await requireUnchangedCredentialFile(rootDir, previous);
    await rename(temporary, path);
  } catch (error) {
    await removeFailedCredentialTemporary(error, temporary);
  }
}

async function removeFailedCredentialTemporary(
  error: unknown,
  temporary: string,
): Promise<never> {
  try {
    await rm(temporary, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Credential saving failed and its temporary file could not be removed.",
    );
  }
  throw error;
}

async function restoreCredentialFile(
  rootDir: string,
  previous: CredentialFileSnapshot,
  written: string,
): Promise<void> {
  if (previous.raw !== undefined) {
    await replaceCredentialFile(rootDir, written, previous.raw, previous.mode);
    return;
  }
  await requireUnchangedCredentialFile(rootDir, written);
  await rm(join(rootDir, ".env"), { force: true });
}

async function restoreCredentialsAfterFailure(
  error: unknown,
  rootDir: string,
  previous: CredentialFileSnapshot,
  written: string,
): Promise<never> {
  try {
    await restoreCredentialFile(rootDir, previous, written);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "Setup failed and its credential file could not be restored.",
    );
  }
  throw error;
}

async function commitOrRestoreCredentials<T>(
  rootDir: string,
  previous: CredentialFileSnapshot,
  written: string,
  commit: () => Promise<T>,
): Promise<T> {
  try {
    return await commit();
  } catch (error) {
    return restoreCredentialsAfterFailure(error, rootDir, previous, written);
  }
}

function readSavedApiKey(raw: string, apiKeyEnv: string): string {
  return parse(raw)[apiKeyEnv]?.trim() ?? "";
}

export function readRuntimeSetupCredential(
  rootDir: string,
  apiKeyEnv = "OPENAI_API_KEY",
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) return "";
  const inherited = process.env[apiKeyEnv]?.trim();
  if (inherited) return inherited;
  const path = join(rootDir, ".env");
  try {
    if (!lstatSync(path).isFile()) return "";
    return readSavedApiKey(readFileSync(path, "utf8"), apiKeyEnv);
  } catch {
    return "";
  }
}

export async function assertRuntimeSetupCredentialFile(
  rootDir: string,
): Promise<void> {
  await readCredentialFile(rootDir);
}

export async function hasRuntimeSetupCredential(
  rootDir: string,
  apiKeyEnv = "OPENAI_API_KEY",
): Promise<boolean> {
  return Boolean(readRuntimeSetupCredential(rootDir, apiKeyEnv));
}

export async function persistRuntimeSetupCredentials(
  params: RuntimeSetupCredentialWrite,
): Promise<void> {
  await commitRuntimeSetupCredentials(params, async () => undefined);
}

/** Keep the credential private and locked until the related setup commit settles. */
export async function commitRuntimeSetupCredentials<T>(
  params: RuntimeSetupCredentialWrite,
  commit: () => Promise<T>,
): Promise<T> {
  const rootDir = await realpath(params.rootDir);
  return withFileLock(join(rootDir, ".env.credentials.lock"), () =>
    saveCredentialAssignments({ ...params, rootDir }, commit),
  );
}

function wouldReplaceConfiguredCredential(
  preserveExistingCredential: boolean | undefined,
  incomingKey: string | undefined,
  configuredKeys: readonly string[],
): boolean {
  if (!preserveExistingCredential) return false;
  if (!incomingKey) return false;
  return configuredKeys.some((configuredKey) => {
    if (!configuredKey) return false;
    return configuredKey !== incomingKey;
  });
}

async function saveCredentialAssignments<T>(
  params: RuntimeSetupCredentialWrite,
  commit: () => Promise<T>,
): Promise<T> {
  const apiKeyEnv = params.apiKeyEnv ?? "OPENAI_API_KEY";
  const previousFile = await readCredentialFileSnapshot(params.rootDir);
  const previous = previousFile.raw ?? "";
  const configuredKeys = [
    readSavedApiKey(previous, apiKeyEnv),
    process.env[apiKeyEnv]?.trim() ?? "",
  ];
  if (
    wouldReplaceConfiguredCredential(
      params.preserveExistingCredential,
      params.apiKey,
      configuredKeys,
    )
  )
    throw new RuntimeSetupError(
      "credential_already_configured",
      "That provider now has a saved API key. Its credential was preserved.",
      409,
    );
  let next = replaceRuntimeSetupEnvironmentAssignment(
    previous,
    "LLM_RUNTIME_CONFIG_FILE",
    params.configPath,
  );
  if (params.apiKey)
    next = replaceRuntimeSetupEnvironmentAssignment(
      next,
      apiKeyEnv,
      params.apiKey,
    );
  await replaceCredentialFile(params.rootDir, previousFile.raw, next);
  const result = await commitOrRestoreCredentials(
    params.rootDir,
    previousFile,
    next,
    commit,
  );
  const key =
    params.apiKey ||
    process.env[apiKeyEnv] ||
    readSavedApiKey(previous, apiKeyEnv);
  if (key) process.env[apiKeyEnv] = key;
  return result;
}
