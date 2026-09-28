import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../config/utils.js";
import { withFileLock } from "./long-term-memory/file-lock.js";

/** Configuration activation can hold this lock throughout shutdown and restart.
 * Cooperating writers wait for release; dead owners remain reclaimable.
 */
export const CONFIG_FILE_LOCK_OPTIONS = Object.freeze({
  waitMs: Number.POSITIVE_INFINITY,
});

type JsonConfig = Record<string, unknown>;
export type ConfigFileReadOptions = Readonly<{ allowMalformedJson?: boolean }>;
export type InvalidConfigJson = Readonly<{ raw: string; message: string }>;
export type ConfigFileSnapshot = Readonly<{
  config: JsonConfig;
  invalidJson?: InvalidConfigJson;
  exists: boolean;
  revision: string;
}>;
export type ConfigFileExpectation = Readonly<{
  expectedConfig?: JsonConfig;
  expectedRevision?: string;
}>;
export type ConfigFileCommit = Readonly<{
  revision: string;
  backupPath?: string;
}>;
export type ConfigFileTransaction = Readonly<{
  path: string;
  snapshot: ConfigFileSnapshot;
  write(
    config: JsonConfig,
    expectation?: ConfigFileExpectation,
  ): Promise<ConfigFileCommit>;
}>;

export class ConfigFileConflictError extends Error {
  readonly code = "config_changed";
  constructor() {
    super(
      "Configuration changed since it was loaded. Refresh Configuration before saving again.",
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Existing targets and missing children of symlinked directories share one lock. */
export async function canonicalConfigFilePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalConfigFilePath(parent), basename(absolute));
  }
}

function configRevision(path: string, raw: Buffer | undefined): string {
  const hash = createHash("sha256").update(path).update("\0");
  if (raw === undefined) return hash.update("missing").digest("hex");
  return hash.update("present:").update(raw).digest("hex");
}

function parseSnapshotConfig(
  raw: Buffer | undefined,
  options: ConfigFileReadOptions,
): Pick<ConfigFileSnapshot, "config" | "invalidJson"> {
  if (raw === undefined) return { config: {} };
  const text = raw.toString("utf8");
  try {
    const config: unknown = JSON.parse(text);
    if (!isRecord(config))
      throw new Error("Configuration must contain a JSON object.");
    return { config };
  } catch (error) {
    if (!options.allowMalformedJson) throw error;
    return {
      config: {},
      invalidJson: {
        raw: text,
        message:
          "This file is not a valid JSON object. Correct its Raw JSON and save the file to repair it.",
      },
    };
  }
}

async function requireRegularConfigFile(path: string): Promise<void> {
  if ((await stat(path)).isFile()) return;
  throw new Error("Configuration path must be a regular file.");
}

async function readSnapshot(path: string, options: ConfigFileReadOptions = {}) {
  let raw: Buffer | undefined;
  try {
    // Inspect before opening: special entries such as FIFOs can block a read.
    await requireRegularConfigFile(path);
    raw = await readFile(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return {
    ...parseSnapshotConfig(raw, options),
    exists: raw !== undefined,
    revision: configRevision(path, raw),
    raw,
  };
}

export async function readConfigFileSnapshot(
  path: string,
  options: ConfigFileReadOptions = {},
): Promise<ConfigFileSnapshot> {
  const { raw: _raw, ...snapshot } = await readSnapshot(
    await canonicalConfigFilePath(path),
    options,
  );
  return snapshot;
}

function requireExpectedSnapshot(
  snapshot: ConfigFileSnapshot,
  expectation: ConfigFileExpectation,
): void {
  if (snapshot.invalidJson && expectation.expectedRevision === undefined)
    throw new ConfigFileConflictError();
  if (
    expectation.expectedRevision !== undefined &&
    expectation.expectedRevision !== snapshot.revision
  )
    throw new ConfigFileConflictError();
  if (
    expectation.expectedConfig !== undefined &&
    !isDeepStrictEqual(expectation.expectedConfig, snapshot.config)
  )
    throw new ConfigFileConflictError();
}

async function requireUnchangedFile(
  path: string,
  revision: string,
  options: ConfigFileReadOptions,
): Promise<void> {
  if ((await readSnapshot(path, options)).revision !== revision)
    throw new ConfigFileConflictError();
}

/** All cooperating config writers hold this lock from read through commit.
 * Revision checks also reject completed external edits; advisory locks cannot
 * exclude an external editor that writes between the final check and rename.
 */
export async function withConfigFileTransaction<T>(
  path: string,
  operation: (transaction: ConfigFileTransaction) => Promise<T>,
  options: ConfigFileReadOptions = {},
): Promise<T> {
  const canonicalPath = await canonicalConfigFilePath(path);
  await mkdir(dirname(canonicalPath), { recursive: true });
  return withFileLock(
    `${canonicalPath}.config.lock`,
    async () => {
      let current = await readSnapshot(canonicalPath, options);
      return operation({
        path: canonicalPath,
        get snapshot() {
          return current;
        },
        async write(config, expectation = {}) {
          requireExpectedSnapshot(current, expectation);
          await requireUnchangedFile(canonicalPath, current.revision, options);
          const token = randomUUID();
          const temporaryPath = `${canonicalPath}.${token}.tmp`;
          const backupPath = current.exists
            ? `${canonicalPath}.${new Date().toISOString().replace(/[:.]/gu, "-")}.${token}.bak`
            : undefined;
          const mode = current.exists
            ? (await stat(canonicalPath)).mode & 0o777
            : 0o600;
          const raw = Buffer.from(
            `${JSON.stringify(config, null, 2)}\n`,
            "utf8",
          );
          try {
            if (backupPath)
              await writeFile(backupPath, current.raw!, {
                encoding: "utf8",
                mode,
                flag: "wx",
              });
            await writeFile(temporaryPath, raw, {
              encoding: "utf8",
              mode,
              flag: "wx",
            });
            await chmod(temporaryPath, mode);
            await requireUnchangedFile(
              canonicalPath,
              current.revision,
              options,
            );
            await rename(temporaryPath, canonicalPath);
          } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
          }
          current = {
            config,
            exists: true,
            revision: configRevision(canonicalPath, raw),
            raw,
          };
          return {
            revision: current.revision,
            ...(backupPath ? { backupPath } : {}),
          };
        },
      });
    },
    CONFIG_FILE_LOCK_OPTIONS,
  );
}
