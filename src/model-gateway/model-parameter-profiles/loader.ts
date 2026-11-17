import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelParameterProfile,
  ModelParameterProfileCatalog,
  ModelParameterProfileDiagnostic,
} from "../../shared/model-parameters.js";
import { parseModelParameterProfile } from "./schema.js";

type ProfileDirectoryState = Readonly<{
  profiles: ReadonlyMap<string, ModelParameterProfile>;
  catalog: ModelParameterProfileCatalog;
}>;

const lastValidLocalProfiles = new Map<string, ProfileDirectoryState>();
const MAX_CACHED_PROFILE_DIRECTORIES = 32;
const MAX_PROFILE_FILES = 256;
const MAX_PROFILE_BYTES = 256 * 1024;

function canonicalProfileDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    /* The local directory may not exist yet. */
  }
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return resolve(path);
  }
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function describeProfileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listProfileFiles(directory: string): string[] {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length > MAX_PROFILE_FILES)
    throw new Error(`Profile directory exceeds ${MAX_PROFILE_FILES} files`);
  return files;
}

function readProfile(
  directory: string,
  filename: string,
): ModelParameterProfile {
  const path = join(directory, filename);
  const metadata = lstatSync(path);
  if (!metadata.isFile())
    throw new Error(
      "Profile must be a regular file, not a directory or symbolic link",
    );
  if (metadata.size > MAX_PROFILE_BYTES)
    throw new Error(`Profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Profile contains invalid JSON");
  }
  return parseModelParameterProfile(parsed, basename(filename, ".json"));
}

function freezeProfileData<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) freezeProfileData(child);
  return Object.freeze(value);
}

function createCatalog(
  profiles: Iterable<ModelParameterProfile>,
  diagnostics: ModelParameterProfileDiagnostic[],
): ModelParameterProfileCatalog {
  const sortedProfiles = Array.from(profiles).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const revision = createHash("sha256")
    .update(JSON.stringify(sortedProfiles))
    .digest("hex")
    .slice(0, 16);
  return freezeProfileData({
    schemaVersion: 1,
    profiles: sortedProfiles,
    diagnostics,
    revision,
  });
}

function readBuiltinProfiles(
  directory: string,
  diagnostics: ModelParameterProfileDiagnostic[],
): Map<string, ModelParameterProfile> {
  const profiles = new Map<string, ModelParameterProfile>();
  let files: string[];
  try {
    files = listProfileFiles(directory);
  } catch (error) {
    diagnostics.push({
      code: "builtin_parameter_profiles_unavailable",
      message: `Bundled parameter profiles could not be loaded: ${describeProfileError(error)}`,
    });
    return profiles;
  }
  for (const filename of files) {
    try {
      const profile = readProfile(directory, filename);
      profiles.set(profile.id, profile);
    } catch (error) {
      diagnostics.push({
        code: "invalid_builtin_parameter_profile",
        profileId: basename(filename, ".json"),
        message: describeProfileError(error),
      });
    }
  }
  return profiles;
}

function retainProfileDirectoryState(
  key: string,
  state: ProfileDirectoryState,
): void {
  lastValidLocalProfiles.delete(key);
  lastValidLocalProfiles.set(key, state);
  if (lastValidLocalProfiles.size <= MAX_CACHED_PROFILE_DIRECTORIES) return;
  const oldestKey = lastValidLocalProfiles.keys().next().value;
  if (oldestKey !== undefined) lastValidLocalProfiles.delete(oldestKey);
}

function readLocalProfiles(params: {
  directory: string;
  files: readonly string[];
  profiles: Map<string, ModelParameterProfile>;
  previous?: ProfileDirectoryState;
  diagnostics: ModelParameterProfileDiagnostic[];
}): Map<string, ModelParameterProfile> {
  const validLocal = new Map<string, ModelParameterProfile>();
  for (const filename of params.files) {
    const profileId = basename(filename, ".json");
    // A broken local override must never silently reveal the bundled profile.
    params.profiles.delete(profileId);
    try {
      const profile = readProfile(params.directory, filename);
      params.profiles.set(profileId, profile);
      validLocal.set(profileId, profile);
    } catch (error) {
      const retained = params.previous?.profiles.get(profileId);
      if (retained) {
        params.profiles.set(profileId, retained);
        validLocal.set(profileId, retained);
      }
      params.diagnostics.push({
        code: retained
          ? "parameter_profile_last_valid_retained"
          : "invalid_local_parameter_profile",
        profileId,
        message: `${describeProfileError(error)}. ${retained ? "The last valid profile remains active until corrected; it cannot be recovered after restart." : "This profile is inactive; no bundled profile with the same id was substituted."}`,
      });
    }
  }
  return validLocal;
}

/** Call only with the runtime's trusted main-config path, never a client-supplied path. */
export function loadModelParameterProfileCatalog(
  options: {
    mainConfigPath?: string;
    builtinDirectory?: string;
  } = {},
): ModelParameterProfileCatalog {
  const diagnostics: ModelParameterProfileDiagnostic[] = [];
  const builtinDirectory =
    options.builtinDirectory ??
    fileURLToPath(new URL("./builtin/", import.meta.url));
  const profiles = readBuiltinProfiles(builtinDirectory, diagnostics);
  if (!options.mainConfigPath)
    return createCatalog(profiles.values(), diagnostics);
  const directory = canonicalProfileDirectory(
    join(dirname(resolve(options.mainConfigPath)), "model-parameter-profiles"),
  );
  const cacheKey = `${canonicalProfileDirectory(builtinDirectory)}\0${directory}`;
  const previous = lastValidLocalProfiles.get(cacheKey);
  let files: string[];
  try {
    files = listProfileFiles(directory);
  } catch (error) {
    if (isMissingDirectory(error)) {
      const catalog = createCatalog(profiles.values(), diagnostics);
      retainProfileDirectoryState(cacheKey, { profiles: new Map(), catalog });
      return catalog;
    }
    diagnostics.push({
      code: "local_parameter_profiles_unavailable",
      message: `${describeProfileError(error)}. ${previous ? "The last valid catalog remains active until corrected; it cannot be recovered after restart." : "Local parameter profiles are inactive."}`,
    });
    return createCatalog(
      previous?.catalog.profiles ?? profiles.values(),
      diagnostics,
    );
  }
  const localProfiles = readLocalProfiles({
    directory,
    files,
    profiles,
    previous,
    diagnostics,
  });
  const catalog = createCatalog(profiles.values(), diagnostics);
  retainProfileDirectoryState(cacheKey, { profiles: localProfiles, catalog });
  return catalog;
}
