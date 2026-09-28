import { readdir, realpath } from "node:fs/promises";
import { assignDiscoveredModelIds } from "./config-dashboard-model-identity.js";
import {
  ConfigFileConflictError,
  canonicalConfigFilePath,
  readConfigFileSnapshot,
  type ConfigFileSnapshot,
  type ConfigFileTransaction,
} from "../runtime/adapters/config-file-transaction.js";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  withConfigDashboardRootTransaction,
  withConfigDashboardTargetTransaction,
} from "./config-dashboard-save-transaction.js";

import { DEFAULT_RUNTIME_CONFIG_FILE } from "../runtime/config/constants.js";
import { REQUEST_INVOKED_STEP_IDS } from "../runtime/config/runner/contracts.js";
import { assertSupportedRequestRunnerConfigVersion } from "../runtime/config/runner/schema-version.js";
import { parseRequestRunnerConfig } from "../runtime/config/runner/versioned-config.js";
import { isRecord, resolveRuntimePath } from "../runtime/config/utils.js";

type JsonRecord = Record<string, unknown>;

export type ConfigFileKind = "runtime" | "requestRunner" | "model";

type ConfigFileDescriptor = {
  kind: ConfigFileKind;
  id: string;
  label: string;
  path: string;
  exists: boolean;
  revision: string;
  config: JsonRecord;
  registered?: boolean;
  invalidJson?: ConfigFileSnapshot["invalidJson"];
  source?: {
    type: "inlineModelProfile";
    runtimeConfigPath: string;
    profileId: string;
  };
};

export type ConfigDashboardSnapshot = {
  rootDir: string;
  configDir: string;
  modelSteps: string[];
  files: {
    runtime: ConfigFileDescriptor;
    requestRunner: ConfigFileDescriptor | null;
    models: ConfigFileDescriptor[];
  };
};

function resolveMainConfigPath(rootDir: string, configPath?: string): string {
  return configPath
    ? resolveRuntimePath(rootDir, configPath)
    : resolve(rootDir, DEFAULT_RUNTIME_CONFIG_FILE);
}

function resolveRefPath(basePath: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(dirname(basePath), ref);
}

function safeRelativePath(rootDir: string, filePath: string): string {
  const relativePath = relative(rootDir, filePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : filePath;
}

function ensureInsideRoot(rootDir: string, filePath: string): void {
  const relativePath = relative(rootDir, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("config file is outside the workspace root");
  }
}

type ModelConfigRef = {
  id: string;
  path: string;
  registered: boolean;
  source?: ConfigFileDescriptor["source"];
  inlineConfig?: JsonRecord;
};

function modelRefsFromRuntimeConfig(params: {
  mainConfigPath: string;
  runtimeConfig: JsonRecord;
}): ModelConfigRef[] {
  const { mainConfigPath, runtimeConfig } = params;
  const models = isRecord(runtimeConfig.models) ? runtimeConfig.models : {};
  const profiles = isRecord(models.profiles) ? models.profiles : {};
  return Object.entries(profiles).flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const configRef =
      typeof value.configRef === "string" ? value.configRef.trim() : "";
    if (configRef) {
      return [{ id, path: configRef, registered: true }];
    }
    return [
      {
        id,
        path: mainConfigPath,
        registered: true,
        source: {
          type: "inlineModelProfile",
          runtimeConfigPath: mainConfigPath,
          profileId: id,
        },
        inlineConfig: value,
      },
    ];
  });
}

function modelIdFromConfigFile(fileName: string): string {
  return fileName.replace(/\.config\.json$/u, "").replace(/\.json$/u, "");
}

function modelDirectoryIsMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function discoverModelRefs(params: {
  mainConfigPath: string;
  runtimeConfig: JsonRecord;
}): Promise<ModelConfigRef[]> {
  const configured = modelRefsFromRuntimeConfig({
    mainConfigPath: params.mainConfigPath,
    runtimeConfig: params.runtimeConfig,
  });
  const requestRunnerRef = configRefFrom(params.runtimeConfig.requestRunner);
  const nonModelConfigPaths = [params.mainConfigPath];
  if (requestRunnerRef)
    nonModelConfigPaths.push(
      resolveRefPath(params.mainConfigPath, requestRunnerRef),
    );
  const excludedFilePaths = new Set(
    await Promise.all(nonModelConfigPaths.map(canonicalConfigFilePath)),
  );
  const visitedFilePaths = new Set<string>();
  const discovered: ModelConfigRef[] = [];
  for (const ref of configured) {
    if (ref.source) continue;
    visitedFilePaths.add(
      await canonicalConfigFilePath(
        resolveRefPath(params.mainConfigPath, ref.path),
      ),
    );
  }

  const modelDirs = new Set([
    resolve(dirname(params.mainConfigPath), "models"),
    ...configured
      .filter((ref) => !ref.source)
      .map((ref) =>
        dirname(resolve(resolveRefPath(params.mainConfigPath, ref.path))),
      ),
  ]);
  for (const modelsDir of [...modelDirs].sort()) {
    let fileNames: string[] = [];
    try {
      fileNames = await readdir(modelsDir);
    } catch (error) {
      if (!modelDirectoryIsMissing(error)) throw error;
    }

    for (const fileName of fileNames.sort()) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = resolve(modelsDir, fileName);
      const canonicalPath = await canonicalConfigFilePath(filePath);
      if (excludedFilePaths.has(canonicalPath)) continue;
      if (visitedFilePaths.has(canonicalPath)) continue;
      visitedFilePaths.add(canonicalPath);
      discovered.push({
        id: modelIdFromConfigFile(fileName),
        path: relative(dirname(params.mainConfigPath), filePath),
        registered: false,
      });
    }
  }

  return [
    ...configured,
    ...assignDiscoveredModelIds(
      configured.map(({ id }) => id),
      discovered,
    ),
  ];
}

function configRefFrom(value: unknown): string {
  if (!isRecord(value)) return "";
  const configRef = value.configRef;
  return typeof configRef === "string" ? configRef.trim() : "";
}

async function readDescriptor(params: {
  rootDir: string;
  kind: ConfigFileKind;
  id: string;
  label: string;
  path: string;
  config?: JsonRecord;
  snapshot?: ConfigFileSnapshot;
  registered?: boolean;
  source?: ConfigFileDescriptor["source"];
}): Promise<ConfigFileDescriptor> {
  ensureInsideRoot(params.rootDir, params.path);
  const path = await canonicalConfigFilePath(params.path);
  ensureInsideRoot(await realpath(params.rootDir), path);
  const snapshot =
    params.snapshot ??
    (await readConfigFileSnapshot(path, {
      allowMalformedJson: params.kind !== "runtime",
    }));
  return {
    kind: params.kind,
    id: params.id,
    label: params.label,
    path: safeRelativePath(params.rootDir, params.path),
    exists: snapshot.exists,
    revision: snapshot.revision,
    config: params.config ?? snapshot.config,
    ...(params.registered === undefined
      ? {}
      : { registered: params.registered }),
    ...(snapshot.invalidJson ? { invalidJson: snapshot.invalidJson } : {}),
    ...(params.source ? { source: params.source } : {}),
  };
}

export async function getConfigDashboardSnapshot(
  params: { rootDir: string; configPath?: string },
  lockedRuntimeSnapshot?: ConfigFileSnapshot,
): Promise<ConfigDashboardSnapshot> {
  const mainConfigPath = resolveMainConfigPath(
    params.rootDir,
    params.configPath,
  );
  const runtimeSnapshot =
    lockedRuntimeSnapshot ?? (await readConfigFileSnapshot(mainConfigPath));
  const runtimeConfig = runtimeSnapshot.config;
  const configDir = dirname(mainConfigPath);

  const requestRunnerRef = configRefFrom(runtimeConfig.requestRunner);
  const requestRunnerPath = requestRunnerRef
    ? resolveRefPath(mainConfigPath, requestRunnerRef)
    : "";
  const requestRunner = requestRunnerPath
    ? await readDescriptor({
        rootDir: params.rootDir,
        kind: "requestRunner",
        id: "requestRunner",
        label: "runtime request runner",
        path: requestRunnerPath,
      })
    : null;
  const modelRefs = await discoverModelRefs({
    mainConfigPath,
    runtimeConfig,
  });

  return {
    rootDir: params.rootDir,
    configDir: safeRelativePath(params.rootDir, configDir),
    modelSteps: [...REQUEST_INVOKED_STEP_IDS],
    files: {
      runtime: await readDescriptor({
        rootDir: params.rootDir,
        kind: "runtime",
        id: "runtime",
        label: "Runtime",
        path: mainConfigPath,
        snapshot: runtimeSnapshot,
      }),
      requestRunner,
      models: await Promise.all(
        modelRefs.map((model) =>
          readDescriptor({
            rootDir: params.rootDir,
            kind: "model",
            id: model.id,
            label: basename(model.path).replace(/\.json$/u, ""),
            registered: model.registered,
            path: resolveRefPath(mainConfigPath, model.path),
            ...(model.inlineConfig
              ? { config: model.inlineConfig, snapshot: runtimeSnapshot }
              : {}),
            ...(model.source ? { source: model.source } : {}),
          }),
        ),
      ),
    },
  };
}

/** Outcome reconciliation waits for writes; ordinary reads require no write access. */
export async function getSettledConfigDashboardSnapshot(params: {
  rootDir: string;
  configPath?: string;
}): Promise<ConfigDashboardSnapshot> {
  const mainConfigPath = resolveMainConfigPath(
    params.rootDir,
    params.configPath,
  );
  const runtimePath = await canonicalConfigFilePath(mainConfigPath);
  return withConfigDashboardRootTransaction(
    runtimePath,
    undefined,
    async (root) => {
      const selectedTarget = await canonicalConfigFilePath(mainConfigPath);
      const hasCurrentRuntimeTarget = selectedTarget === root.path;
      if (!hasCurrentRuntimeTarget) throw new ConfigFileConflictError();
      const snapshot = await getConfigDashboardSnapshot(params, root.snapshot);
      const hasSameRuntimeTarget =
        (await canonicalConfigFilePath(mainConfigPath)) === root.path;
      if (!hasSameRuntimeTarget) throw new ConfigFileConflictError();
      return snapshot;
    },
  );
}

function selectConfigDashboardTarget(
  snapshot: ConfigDashboardSnapshot,
  kind: ConfigFileKind,
  id?: string,
): ConfigFileDescriptor | null | undefined {
  if (kind === "runtime") return snapshot.files.runtime;
  if (kind === "requestRunner") return snapshot.files.requestRunner;
  return snapshot.files.models.find((model) => model.id === id);
}

function validateDashboardRequestRunnerCandidate(
  kind: ConfigFileKind,
  snapshot: ConfigFileSnapshot,
  candidate: JsonRecord,
  filePath: string,
): void {
  if (kind !== "requestRunner") return;
  if (snapshot.exists && !snapshot.invalidJson)
    assertSupportedRequestRunnerConfigVersion(snapshot.config, filePath);
  parseRequestRunnerConfig(candidate, filePath);
}

export async function saveConfigDashboardFile(params: {
  rootDir: string;
  configPath?: string;
  kind: ConfigFileKind;
  id?: string;
  config: unknown;
  expectedRevision?: string;
  transaction?: ConfigFileTransaction;
}): Promise<{
  ok: true;
  file: ConfigFileDescriptor;
  backupPath?: string;
}> {
  if (!isRecord(params.config)) {
    throw new Error("config must be a JSON object");
  }
  const mainConfigPath = resolveMainConfigPath(
    params.rootDir,
    params.configPath,
  );
  ensureInsideRoot(params.rootDir, mainConfigPath);
  const runtimePath = await canonicalConfigFilePath(mainConfigPath);
  ensureInsideRoot(await realpath(params.rootDir), runtimePath);
  return withConfigDashboardRootTransaction(
    runtimePath,
    params.transaction,
    async (rootTransaction) => {
      const snapshot = await getConfigDashboardSnapshot(
        { rootDir: params.rootDir, configPath: params.configPath },
        rootTransaction.snapshot,
      );
      const target = selectConfigDashboardTarget(
        snapshot,
        params.kind,
        params.id,
      );
      if (!target) {
        throw new Error("config file target was not found");
      }
      const filePath = await canonicalConfigFilePath(
        resolve(params.rootDir, target.path),
      );
      ensureInsideRoot(await realpath(params.rootDir), filePath);
      const save = async (transaction: ConfigFileTransaction) => {
        if (transaction.path !== filePath)
          throw new Error("Configuration transaction target does not match.");
        if (!isRecord(params.config))
          throw new Error("config must be a JSON object");
        let candidate = params.config;
        if (target.source?.type === "inlineModelProfile") {
          const runtimeConfig = transaction.snapshot.config;
          const models = isRecord(runtimeConfig.models)
            ? runtimeConfig.models
            : {};
          const profiles = isRecord(models.profiles) ? models.profiles : {};
          candidate = {
            ...runtimeConfig,
            models: {
              ...models,
              profiles: {
                ...profiles,
                [target.source.profileId]: params.config,
              },
            },
          };
        }
        validateDashboardRequestRunnerCandidate(
          target.kind,
          transaction.snapshot,
          candidate,
          filePath,
        );
        const result = await transaction.write(candidate, {
          expectedRevision: params.expectedRevision,
        });
        const file = await readDescriptor({
          rootDir: params.rootDir,
          kind: target.kind,
          id: target.id,
          label: target.label,
          registered: target.registered,
          path: filePath,
          snapshot: transaction.snapshot,
          ...(target.source
            ? { source: target.source, config: params.config }
            : {}),
        });
        return {
          ok: true as const,
          file,
          ...(result.backupPath
            ? {
                backupPath: safeRelativePath(params.rootDir, result.backupPath),
              }
            : {}),
        };
      };
      return withConfigDashboardTargetTransaction(
        rootTransaction,
        filePath,
        save,
      );
    },
  );
}
