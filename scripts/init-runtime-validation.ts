import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import {
  loadRuntimeConfig,
  RuntimeConfigValidationError,
} from "../src/runtime/config.js";
import {
  isRecord,
  readJsonObject,
  type JsonObject,
} from "./runtime-setup-files.js";
import { validateRuntimeConfigFile } from "../src/runtime/config/validation.js";
import type { InitFilePlan } from "./init-runtime-plan.js";

function rebaseConfigReference(
  value: unknown,
  configPath: string,
  stagedPaths: ReadonlyMap<string, string>,
): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.configRef !== "string" || !value.configRef.trim())
    return value;
  const target = resolve(dirname(configPath), value.configRef.trim());
  return { ...value, configRef: stagedPaths.get(target) ?? target };
}

async function rebaseRunnerInstructions(
  runner: unknown,
  runnerPath: string,
  stagedPaths: ReadonlyMap<string, string>,
  staging: string,
  diagnosticPaths: Map<string, string>,
): Promise<unknown> {
  if (!isRecord(runner)) return runner;
  if (!isRecord(runner.steps)) return runner;
  const aliases = new Map<string, string>();

  async function stageInstructionReference(ref: unknown): Promise<unknown> {
    if (typeof ref !== "string") return ref;
    const originalRef = ref.trim();
    if (!originalRef) return ref;
    const existingAlias = aliases.get(originalRef);
    if (existingAlias) return existingAlias;
    const target = resolve(dirname(runnerPath), originalRef);
    // Preserve distinct reference identities so canonical count and content-size
    // validation sees the same instructions as the eventual persisted runner.
    const alias = join(
      staging,
      `instruction-${aliases.size}${extname(target)}`,
    );
    aliases.set(originalRef, alias);
    diagnosticPaths.set(alias, target);
    await writeFile(alias, await readFile(stagedPaths.get(target) ?? target));
    return alias;
  }

  async function stageRunnerStep(step: unknown): Promise<unknown> {
    if (!isRecord(step)) return step;
    if (!Array.isArray(step.instructionRefs)) return step;
    const instructionRefs: unknown[] = [];
    for (const ref of step.instructionRefs)
      instructionRefs.push(await stageInstructionReference(ref));
    return { ...step, instructionRefs };
  }

  const steps: Array<[string, unknown]> = [];
  for (const [id, step] of Object.entries(runner.steps))
    steps.push([id, await stageRunnerStep(step)]);
  return { ...runner, steps: Object.fromEntries(steps) };
}

function initValidationFailure(
  error: unknown,
  config: JsonObject | undefined,
  configPath: string,
  files: readonly InitFilePlan[],
  diagnosticPaths: ReadonlyMap<string, string>,
): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const [staged, target] of diagnosticPaths)
    message = message.replaceAll(staged, target);
  const keptConfiguration = files.some(
    (file) => file.status === "kept" && file.relativePath.startsWith("local/"),
  );
  const guidance = ["No initialization files were written."];
  if (!keptConfiguration)
    return new Error(
      [message, ...guidance, "Correct the init options and retry."].join("\n"),
      { cause: error },
    );

  guidance.push(
    "Existing configuration was preserved. Init options do not update existing files.",
    `Back up and edit the existing configuration at ${configPath} and its referenced files, then rerun init.`,
  );
  const models = isRecord(config?.models) ? config.models : {};
  const profiles = isRecord(models.profiles) ? models.profiles : {};
  const capacityIssues =
    error instanceof RuntimeConfigValidationError ? error.capacityIssues : [];
  for (const issue of capacityIssues) {
    const profile = profiles[issue.profileId];
    const target =
      isRecord(profile) && typeof profile.configRef === "string"
        ? resolve(dirname(configPath), profile.configRef.trim())
        : configPath;
    guidance.push(
      `Profile ${issue.profileId}: back up and edit ${target}; set contextWindowTokens (including any override in ${configPath}) to a supported capacity of at least ${issue.minimumTokens}.`,
    );
    if (issue.allocationTokens !== undefined)
      guidance.push(
        `Also ensure options.num_ctx is at least ${issue.minimumTokens}.`,
      );
  }
  return new Error([message, ...guidance].join("\n"), { cause: error });
}

/** Validate the planned files with the canonical loader, retaining real reference bases. */
export async function validateInitRuntimeFiles(
  rootDir: string,
  files: readonly InitFilePlan[],
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "abot-init-validation-"));
  const configPath = join(rootDir, "local/runtime.config.json");
  const stagedPaths = new Map(
    files.map((file) => [
      join(rootDir, file.relativePath),
      join(staging, file.relativePath),
    ]),
  );
  const diagnosticPaths = new Map(
    [...stagedPaths].map(([target, staged]) => [staged, target]),
  );
  let config: JsonObject | undefined;
  try {
    for (const file of files) {
      const target = stagedPaths.get(join(rootDir, file.relativePath))!;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf-8");
    }
    const stagedConfigPath = stagedPaths.get(configPath)!;
    config = await readJsonObject(stagedConfigPath);
    validateRuntimeConfigFile(config, configPath);
    const stagedConfig = { ...config };
    if (isRecord(config.models) && isRecord(config.models.profiles)) {
      stagedConfig.models = {
        ...config.models,
        profiles: Object.fromEntries(
          Object.entries(config.models.profiles).map(([id, profile]) => [
            id,
            rebaseConfigReference(profile, configPath, stagedPaths),
          ]),
        ),
      };
    }
    const runner = rebaseConfigReference(
      config.requestRunner,
      configPath,
      stagedPaths,
    );
    stagedConfig.requestRunner = runner;
    if (
      isRecord(runner) &&
      typeof runner.configRef === "string" &&
      runner.configRef.trim()
    ) {
      const originalRunner = config.requestRunner as JsonObject;
      const runnerPath = resolve(
        dirname(configPath),
        String(originalRunner.configRef).trim(),
      );
      const runnerConfig = JSON.parse(
        await readFile(runner.configRef, "utf-8"),
      );
      const stagedRunnerPath = join(staging, "validation-runner.json");
      diagnosticPaths.set(stagedRunnerPath, runnerPath);
      await writeFile(
        stagedRunnerPath,
        JSON.stringify(
          await rebaseRunnerInstructions(
            runnerConfig,
            runnerPath,
            stagedPaths,
            staging,
            diagnosticPaths,
          ),
        ),
      );
      stagedConfig.requestRunner = { ...runner, configRef: stagedRunnerPath };
    }
    await writeFile(stagedConfigPath, JSON.stringify(stagedConfig));
    const environment = isRecord(config.environment) ? config.environment : {};
    const profileIds = isRecord(environment.profiles)
      ? Object.keys(environment.profiles)
      : [];
    const environments = profileIds.length > 0 ? profileIds : [undefined];
    for (const profileId of environments) {
      loadRuntimeConfig({
        rootDir,
        configPath: stagedConfigPath,
        envPath: stagedPaths.get(join(rootDir, ".env")),
        profileId,
      });
    }
  } catch (error) {
    throw initValidationFailure(
      error,
      config,
      configPath,
      files,
      diagnosticPaths,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
