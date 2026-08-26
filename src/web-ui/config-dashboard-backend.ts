import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_RUNTIME_CONFIG_FILE } from "../runtime/config/constants.js";
import { isRecord, resolveRuntimePath } from "../runtime/config/utils.js";
import { REQUEST_INVOKED_STEP_IDS } from "../runtime/config/runner/contracts.js";

type JsonRecord = Record<string, unknown>;

export type ConfigFileKind = "runtime" | "requestRunner" | "model";

type ConfigFileDescriptor = {
  kind: ConfigFileKind;
  id: string;
  label: string;
  path: string;
  exists: boolean;
  config: JsonRecord;
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

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid JSON object at ${filePath}`);
  }
  return parsed;
}

type ModelConfigRef = {
  id: string;
  path: string;
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
      return [{ id, path: configRef }];
    }
    return [
      {
        id,
        path: mainConfigPath,
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

async function discoverModelRefs(params: {
  mainConfigPath: string;
  runtimeConfig: JsonRecord;
}): Promise<ModelConfigRef[]> {
  const configured = modelRefsFromRuntimeConfig({
    mainConfigPath: params.mainConfigPath,
    runtimeConfig: params.runtimeConfig,
  });
  const configuredKeys = new Set<string>();
  const discovered: ModelConfigRef[] = [];
  for (const ref of configured) {
    const key = ref.source
      ? `inline:${ref.id}`
      : `file:${resolveRefPath(params.mainConfigPath, ref.path)}`;
    configuredKeys.add(key);
  }

  const firstFileRef = configured.find((ref) => !ref.source)?.path;
  const modelsDir = firstFileRef
    ? dirname(resolveRefPath(params.mainConfigPath, firstFileRef))
    : resolve(dirname(params.mainConfigPath), "models");
  let fileNames: string[] = [];
  try {
    fileNames = await readdir(modelsDir);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = resolve(modelsDir, fileName);
    const key = `file:${filePath}`;
    if (configuredKeys.has(key)) continue;
    discovered.push({
      id: modelIdFromConfigFile(fileName),
      path: relative(dirname(params.mainConfigPath), filePath),
    });
  }

  return [
    ...configured,
    ...discovered.sort((left, right) => left.id.localeCompare(right.id)),
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
  source?: ConfigFileDescriptor["source"];
}): Promise<ConfigFileDescriptor> {
  ensureInsideRoot(params.rootDir, params.path);
  return {
    kind: params.kind,
    id: params.id,
    label: params.label,
    path: safeRelativePath(params.rootDir, params.path),
    exists: existsSync(params.path),
    config: params.config ?? (await readJsonObject(params.path)),
    ...(params.source ? { source: params.source } : {}),
  };
}

function backupPathFor(filePath: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${filePath}.${stamp}.bak`;
}

async function writeJsonObject(
  filePath: string,
  config: JsonRecord,
): Promise<{
  backupPath?: string;
}> {
  await mkdir(dirname(filePath), { recursive: true });
  let backupPath: string | undefined;
  try {
    const current = await readFile(filePath, "utf-8");
    backupPath = backupPathFor(filePath);
    await writeFile(backupPath, current, "utf-8");
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await rename(tempPath, filePath);
  return backupPath ? { backupPath } : {};
}

export async function getConfigDashboardSnapshot(params: {
  rootDir: string;
  configPath?: string;
}): Promise<ConfigDashboardSnapshot> {
  const mainConfigPath = resolveMainConfigPath(
    params.rootDir,
    params.configPath,
  );
  const runtimeConfig = await readJsonObject(mainConfigPath);
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
      }),
      requestRunner,
      models: await Promise.all(
        modelRefs.map((model) =>
          readDescriptor({
            rootDir: params.rootDir,
            kind: "model",
            id: model.id,
            label: basename(model.path).replace(/\.json$/u, ""),
            path: resolveRefPath(mainConfigPath, model.path),
            ...(model.inlineConfig ? { config: model.inlineConfig } : {}),
            ...(model.source ? { source: model.source } : {}),
          }),
        ),
      ),
    },
  };
}

export async function saveConfigDashboardFile(params: {
  rootDir: string;
  configPath?: string;
  kind: ConfigFileKind;
  id?: string;
  config: unknown;
}): Promise<{
  ok: true;
  file: ConfigFileDescriptor;
  backupPath?: string;
}> {
  if (!isRecord(params.config)) {
    throw new Error("config must be a JSON object");
  }
  const snapshot = await getConfigDashboardSnapshot({
    rootDir: params.rootDir,
    configPath: params.configPath,
  });
  const target =
    params.kind === "runtime"
      ? snapshot.files.runtime
      : params.kind === "requestRunner"
        ? snapshot.files.requestRunner
        : snapshot.files.models.find((model) => model.id === params.id);
  if (!target) {
    throw new Error("config file target was not found");
  }
  const filePath = resolve(params.rootDir, target.path);
  if (target.source?.type === "inlineModelProfile") {
    const runtimeConfigPath = target.source.runtimeConfigPath;
    ensureInsideRoot(params.rootDir, runtimeConfigPath);
    const runtimeConfig = await readJsonObject(runtimeConfigPath);
    const models = isRecord(runtimeConfig.models) ? runtimeConfig.models : {};
    const profiles = isRecord(models.profiles) ? models.profiles : {};
    runtimeConfig.models = {
      ...models,
      profiles: {
        ...profiles,
        [target.source.profileId]: params.config,
      },
    };
    const result = await writeJsonObject(runtimeConfigPath, runtimeConfig);
    const nextSnapshot = await getConfigDashboardSnapshot({
      rootDir: params.rootDir,
      configPath: params.configPath,
    });
    const file = nextSnapshot.files.models.find(
      (model) => model.id === target.id,
    );
    if (!file) {
      throw new Error("inline model profile was not found after save");
    }
    return {
      ok: true,
      file,
      ...(result.backupPath
        ? { backupPath: safeRelativePath(params.rootDir, result.backupPath) }
        : {}),
    };
  }
  ensureInsideRoot(params.rootDir, filePath);
  const result = await writeJsonObject(filePath, params.config);
  const file = await readDescriptor({
    rootDir: params.rootDir,
    kind: target.kind,
    id: target.id,
    label: target.label,
    path: filePath,
  });
  return {
    ok: true,
    file,
    ...(result.backupPath
      ? { backupPath: safeRelativePath(params.rootDir, result.backupPath) }
      : {}),
  };
}
