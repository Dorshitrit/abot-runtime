import { requireConnectedChatGptSetupAccount } from "./chatgpt-setup-binding.js";
import { buildProviderConfig } from "../../../scripts/runtime-setup-files.js";
import { inspectModelSetupConnection } from "./model-connection-inspection.js";
import { resolveRuntimeSetupCredentialEnvironment } from "./runtime-setup-auth.js";
import { requireRuntimeSetupEditSettled } from "./runtime-setup-edit-recovery.js";
import { readDefaultContextWindowTokens } from "../../../scripts/runtime-setup-files.js";
import { initializeConfiguredRuntimeDirectories } from "../../../scripts/runtime-setup-directories.js";
import {
  configuredSetupModel,
  requiresConfiguredCredential,
} from "./runtime-setup-provider.js";
import { editRuntimeSetupConnection } from "./runtime-setup-connection-edit.js";
import {
  inspectEditableRuntimeSetupDraft,
  isCurrentRuntimeSetupDraft,
  readRuntimeSetupDraft,
  removeRuntimeSetupDraft,
  setupConfigurationChanged,
  setupConfigMap,
  type RuntimeSetupDraft,
} from "./runtime-setup-draft.js";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import { inspectRuntimeSetupRequirement } from "./runtime-availability.js";
import {
  assertRuntimeSetupCredentialFile,
  hasRuntimeSetupCredential,
  readRuntimeSetupCredential,
  persistRuntimeSetupCredentials,
  commitRuntimeSetupCredentials,
} from "./runtime-setup-credentials.js";
import {
  RuntimeSetupError,
  parseRuntimeSetupInput,
  type RuntimeSetupActivation,
} from "./runtime-setup-input.js";
import { writeRuntimeSetupScaffold } from "./runtime-setup-scaffold.js";
import { inspectRuntimeSetupDraftForSave } from "./runtime-setup-draft-recovery.js";
import { canCompleteMissingRuntimeSetupCredential } from "./runtime-setup-credential-completion.js";

export type RuntimeSetupServiceOptions = {
  rootDir: string;
  getConfigPath: () => string | undefined;
  activate: (configPath: string) => Promise<RuntimeSetupActivation>;
  configure?: (configPath: string) => void;
};

export class RuntimeSetupService {
  private savedConfigPath: string | undefined;

  constructor(private readonly options: RuntimeSetupServiceOptions) {}

  private source() {
    requireRuntimeSetupEditSettled(this.options.rootDir);
    return inspectRuntimeConfigFileWithMeta(
      this.options.rootDir,
      this.savedConfigPath ?? this.options.getConfigPath(),
    );
  }

  async status() {
    const source = this.source();
    const configRequirement = inspectRuntimeSetupRequirement(source);
    const existingModel = configRequirement
      ? undefined
      : configuredSetupModel(source);
    const draft = await inspectEditableRuntimeSetupDraft(source);
    const editable = draft !== undefined;
    const required =
      configRequirement ||
      requiresConfiguredCredential(source, this.options.rootDir);
    return {
      status: required ? ("required" as const) : ("ready" as const),
      configExists: source.exists,
      ...(configRequirement?.recovery
        ? {
            recovery: configRequirement.recovery,
            message: configRequirement.message,
          }
        : {}),
      ...(editable ? { editableConnection: { revision: draft.revision } } : {}),
      defaultContextWindowTokens: await readDefaultContextWindowTokens(),
      ...(existingModel
        ? {
            existingModel: {
              provider: existingModel.provider,
              ...(existingModel.accountRef ? { accountRef: existingModel.accountRef, authentication: "chatgpt" } : {}),
              model: existingModel.model,
              contextWindowTokens: existingModel.contextWindowTokens,
              supportsThinking: existingModel.supportsThinking,
              reasoningBudget: existingModel.reasoningBudget,
              ...(existingModel.promptCache ? { promptCache: true } : {}),
              ...(existingModel.baseUrl
                ? { baseUrl: existingModel.baseUrl }
                : {}),
            },
          }
        : {}),
      providers: [
        { id: "openai-chatgpt", label: "Continue with ChatGPT", requiresApiKey: false, credentialConfigured: false, authentication: "chatgpt" },
        {
          id: "llamacpp",
          label: "llama.cpp",
          description: "A separately running llama-server with token reasoning controls",
          requiresApiKey: existingModel?.provider === "llamacpp" && existingModel.requiresApiKey,
          credentialConfigured: existingModel?.provider === "llamacpp" && Boolean(existingModel.apiKeyEnv) &&
            await hasRuntimeSetupCredential(this.options.rootDir, existingModel.apiKeyEnv),
        },
        {
          id: "ollama",
          label: "Ollama",
          requiresApiKey: false,
          credentialConfigured: false,
        },
        {
          id: "openai",
          label: "OpenAI",
          requiresApiKey: true,
          credentialConfigured: await hasRuntimeSetupCredential(
            this.options.rootDir,
            existingModel?.provider === "openai" ? existingModel.apiKeyEnv : undefined,
          ),
        },
      ],
    };
  }

  async inspectConnection(body: Record<string, unknown>, signal: AbortSignal) {
    return inspectModelSetupConnection(
      { rootDir: this.options.rootDir, configPath: this.source().path }, body, signal,
    );
  }

  async finalize(connectionRevision?: string): Promise<boolean> {
    return withFileLock(
      join(this.options.rootDir, ".runtime-setup.lock"),
      async () => {
        const source = this.source();
        const draft = await readRuntimeSetupDraft(source.path);
        if (!draft) return connectionRevision === undefined;
        if (draft.revision !== connectionRevision) return false;
        if (!(await isCurrentRuntimeSetupDraft(source, draft))) return false;
        await removeRuntimeSetupDraft(source.path);
        return true;
      },
    );
  }

  async save(body: Record<string, unknown> | null) {
    const input = parseRuntimeSetupInput(body);
    try {
      await requireConnectedChatGptSetupAccount(buildProviderConfig(input.provider, input.baseUrl, undefined, input.accountRef));
    } catch (error) {
      throw new RuntimeSetupError("setup_account_unavailable", (error as Error).message, 409);
    }
    await mkdir(this.options.rootDir, { recursive: true });
    return withFileLock(
      join(this.options.rootDir, ".runtime-setup.lock"),
      async () => {
        await assertRuntimeSetupCredentialFile(this.options.rootDir);
        const source = this.source();
        const requirement = inspectRuntimeSetupRequirement(source);
        if (requirement?.recovery === "configuration")
          throw new RuntimeSetupError(
            "setup_configuration_exists",
            "Existing model profiles need repair in Models before setup can continue.",
            409,
          );
        const existingModel = requirement
          ? undefined
          : configuredSetupModel(source);
        const recovery = await inspectRuntimeSetupDraftForSave(source);
        let draft = recovery.draft;
        const editingDraft = input.connectionRevision !== undefined;
        if (editingDraft) {
          if (!draft || draft.revision !== input.connectionRevision)
            throw setupConfigurationChanged();
          if (!(await isCurrentRuntimeSetupDraft(source, draft)))
            throw setupConfigurationChanged();
        }
        const canCompleteCredential =
          !editingDraft &&
          canCompleteMissingRuntimeSetupCredential(
            existingModel,
            input,
            this.options.rootDir,
          );
        if (draft && !editingDraft && !canCompleteCredential)
          throw setupConfigurationChanged();
        if (existingModel && !editingDraft && !canCompleteCredential) {
          throw new RuntimeSetupError(
            "setup_configuration_exists",
            "Model settings already exist. Complete the configured model or use configuration settings.",
            409,
          );
        }
        const requestedProviders = setupConfigMap(
          setupConfigMap(source.config.models).providers,
        );
        const requestedProvider = setupConfigMap(
          requestedProviders[input.provider],
        );
        const apiKeyEnv = resolveRuntimeSetupCredentialEnvironment(
          input.provider,
          requestedProvider,
          input.apiKey,
        );
        const hasCredential =
          input.apiKey ||
          (await hasRuntimeSetupCredential(this.options.rootDir, apiKeyEnv));
        if ((input.provider === "openai" || apiKeyEnv !== undefined) && !hasCredential) {
          throw new RuntimeSetupError(
            "setup_credential_required",
            "Enter the API key for this connection to finish setup.",
          );
        }
        const configuredPath = this.options.getConfigPath();
        const shouldUseLocalConfig = !source.exists && !configuredPath;
        const configPath = shouldUseLocalConfig
          ? join(this.options.rootDir, "local/runtime.config.json")
          : source.path;
        this.options.configure?.(configPath);
        let embeddingInvalidated = false;
        const credentialChanged = Boolean(
          input.apiKey &&
          input.apiKey !==
            readRuntimeSetupCredential(this.options.rootDir, apiKeyEnv),
        );
        const credentialWrite = {
          rootDir: this.options.rootDir,
          configPath: resolve(configPath),
          apiKey: input.apiKey,
          apiKeyEnv,
          preserveExistingCredential: canCompleteCredential,
        };
        let credentialsPersisted = false;
        const commitScaffoldCredentials = async (
          commit: () => Promise<RuntimeSetupDraft>,
        ) => {
          const saved = await commitRuntimeSetupCredentials(
            credentialWrite,
            commit,
          );
          credentialsPersisted = true;
          return saved;
        };
        if (draft && editingDraft) {
          const edited = await editRuntimeSetupConnection({
            rootDir: this.options.rootDir,
            configPath,
            draft,
            input,
            credentialChanged,
            credentialWrite,
          });
          credentialsPersisted = true;
          draft = edited.draft;
          embeddingInvalidated = edited.embeddingInvalidated;
        }
        if (!draft && !canCompleteCredential) {
          const needsAtomicRecoveryCredentialCommit =
            recovery.recoveringDraft && credentialChanged;
          const saved = await writeRuntimeSetupScaffold({
            rootDir: this.options.rootDir,
            configPath,
            source,
            input,
            recoveringDraft: recovery.recoveringDraft,
            recoveryDraft: recovery.recoveryDraft,
            credentialChanged,
            ...(needsAtomicRecoveryCredentialCommit
              ? { commitWithCredentials: commitScaffoldCredentials }
              : {}),
          });
          draft = saved.draft;
          embeddingInvalidated = saved.embeddingInvalidated;
        }
        this.savedConfigPath = configPath;
        if (!credentialsPersisted)
          await persistRuntimeSetupCredentials(credentialWrite);
        await initializeConfiguredRuntimeDirectories(
          this.options.rootDir,
          configPath,
        );
        const activation: RuntimeSetupActivation = input.deferActivation
          ? {
              status: "restart_required",
              message:
                "Connection saved. Continue setup before applying the configuration.",
            }
          : await this.options.activate(configPath);
        if (activation.status === "ready" && draft)
          await removeRuntimeSetupDraft(configPath);
        return { setup: await this.status(), activation, embeddingInvalidated };
      },
    );
  }
}
