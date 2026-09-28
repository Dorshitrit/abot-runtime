import { lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalConfigFilePath,
  readConfigFileSnapshot,
  withConfigFileTransaction,
  type ConfigFileSnapshot,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { ModelSetupError } from "./model-setup-input.js";

type ProfileFileOptions = { rootDir: string; configPath: string };

function declaredModelSetupProfilePath(
  options: ProfileFileOptions,
  profileId: string,
): string {
  return resolve(
    dirname(options.configPath),
    `./models/${profileId}.config.json`,
  );
}

export async function modelSetupProfilePath(
  options: ProfileFileOptions,
  profileId: string,
): Promise<string> {
  return canonicalConfigFilePath(
    declaredModelSetupProfilePath(options, profileId),
  );
}

export async function isDiscoveredModelSetupProfileAtTarget(
  options: ProfileFileOptions,
  profileId: string,
  discoveredPath: string,
): Promise<boolean> {
  return (
    (await canonicalConfigFilePath(discoveredPath)) ===
    (await modelSetupProfilePath(options, profileId))
  );
}

function matchesRequestedModelSetupProfile(
  snapshot: ConfigFileSnapshot,
  profile: Record<string, unknown>,
): boolean {
  if (snapshot.invalidJson) return false;
  return isDeepStrictEqual(snapshot.config, profile);
}

function requireProfileInsideWorkspace(rootDir: string, path: string): void {
  const target = relative(rootDir, path);
  if (!target.startsWith("..") && !isAbsolute(target)) return;
  throw new ModelSetupError(
    "model_config_outside_workspace",
    "The model configuration must be inside the workspace.",
    409,
  );
}

function rejectExistingModelFile(): never {
  throw new ModelSetupError(
    "model_profile_exists",
    "A model file already uses this profile ID. Choose another ID.",
    409,
  );
}

async function requireAbsentModelProfileEntry(path: string): Promise<void> {
  try {
    // A dangling symlink is an existing user-owned entry, not a new file.
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  rejectExistingModelFile();
}

async function requireUnchangedProfileTarget(
  declaredPath: string,
  expectedPath: string,
): Promise<void> {
  if ((await canonicalConfigFilePath(declaredPath)) === expectedPath) return;
  throw new ModelSetupError(
    "config_changed",
    "The model file reference changed while being checked. Reload Configuration before retrying.",
    409,
  );
}

async function discardUncommittedProfile(
  root: ConfigFileTransaction,
  rootRevision: string,
  path: string,
  profileRevision: string,
): Promise<void> {
  // A changed root or child may belong to an external editor; preserve it.
  try {
    if ((await readConfigFileSnapshot(root.path)).revision !== rootRevision)
      return;
    if ((await readConfigFileSnapshot(path)).revision !== profileRevision)
      return;
    await rm(path);
  } catch {
    // Cleanup must never hide the original save failure or erase uncertain data.
  }
}

/** The caller holds the Runtime lock; a new or exact existing profile is locked until commit. */
export async function withModelSetupProfile<T>(
  options: ProfileFileOptions,
  root: ConfigFileTransaction,
  profileId: string,
  profile: Record<string, unknown>,
  commit: (
    declaration: { configRef: string },
    assertProfileUnchanged: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const configRef = `./models/${profileId}.config.json`;
  const declaredPath = declaredModelSetupProfilePath(options, profileId);
  const path = await modelSetupProfilePath(options, profileId);
  requireProfileInsideWorkspace(options.rootDir, path);
  if (path === root.path) rejectExistingModelFile();
  return withConfigFileTransaction(
    path,
    async (target) => {
      await requireUnchangedProfileTarget(declaredPath, path);
      const createdByThisAddition = !target.snapshot.exists;
      if (
        !createdByThisAddition &&
        !matchesRequestedModelSetupProfile(target.snapshot, profile)
      )
        rejectExistingModelFile();
      const rootRevision = root.snapshot.revision;
      if (createdByThisAddition) {
        await requireAbsentModelProfileEntry(declaredPath);
        await target.write(profile);
      }
      const profileRevision = target.snapshot.revision;
      const assertProfileUnchanged = async () => {
        await requireUnchangedProfileTarget(declaredPath, path);
        if (
          (await readConfigFileSnapshot(path, { allowMalformedJson: true }))
            .revision !== profileRevision
        )
          throw new ModelSetupError(
            "config_changed",
            "The model file changed while saving. Reload Configuration to check the saved model.",
            409,
          );
      };
      try {
        await assertProfileUnchanged();
        // The confirmed Runtime commit is the save boundary. Later external
        // profile edits must not report the committed declaration as rejected.
        return await commit({ configRef }, assertProfileUnchanged);
      } catch (error) {
        if (createdByThisAddition)
          await discardUncommittedProfile(
            root,
            rootRevision,
            path,
            profileRevision,
          );
        throw error;
      }
    },
    { allowMalformedJson: true },
  );
}

/** Preserve exact retry identity for both legacy inline and linked declarations. */
export async function readSavedModelSetupProfile(
  options: ProfileFileOptions,
  declaration: Record<string, unknown>,
) {
  if (!Object.hasOwn(declaration, "configRef"))
    return { profile: declaration, assertUnchanged: async () => {} };
  if (typeof declaration.configRef !== "string") rejectExistingModelFile();
  if (Object.keys(declaration).length !== 1) rejectExistingModelFile();
  const declaredPath = resolve(
    dirname(options.configPath),
    declaration.configRef,
  );
  const path = await canonicalConfigFilePath(declaredPath);
  requireProfileInsideWorkspace(options.rootDir, path);
  const snapshot = await readConfigFileSnapshot(path);
  if (!snapshot.exists) rejectExistingModelFile();
  return {
    profile: snapshot.config,
    async assertUnchanged() {
      await requireUnchangedProfileTarget(declaredPath, path);
      if ((await readConfigFileSnapshot(path)).revision !== snapshot.revision)
        throw new ModelSetupError(
          "config_changed",
          "The saved model file changed while being checked. Reload Configuration before retrying.",
          409,
        );
    },
  };
}
