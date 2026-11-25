import { readAgentNotificationApprovals } from "./notification-approvals.js";
import { projectAgentNotifications, type AgentNotificationCursor } from "./notification-attention.js";
import { join } from "node:path";
import { createDefaultModelGatewayClient } from "../default-environment-adapters.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import type { RuntimeEnvironmentServices, RuntimeRequestHandler } from "../composition.js";
import type { RuntimeConfig } from "../ports.js";
import { createAgentWorkspaceApprovals } from "./workspace-approvals.js";
import { attentionMessageIdsThrough, projectAgentAttention, type AgentAttentionCursor } from "./attention.js";
import { createAgentWebCleanup } from "./workspace-web-cleanup.js";
import { wasAgentDeleted } from "./deletion-state.js";
import { FileAgentStateStore } from "./file-store.js";
import { createAgentModelBinding } from "./model-binding.js";
import { createAgentApplication } from "./application-service.js";
import { createAgentApplicationObserver } from "./application-observer.js";
import { createAgentChatUpdates } from "./chat-updates.js";
import { createAgentCoordinationPort } from "./coordination-port.js";
import { createAgentDeletion } from "./deletion.js";
import { createAgentManagementService } from "./management-service.js";
import { createOrdinaryAgentSessionPort } from "./ordinary-session-port.js";
import { createAgentProgressReporter } from "./progress-reporter.js";
import { createAgentScheduleService } from "./schedule-service.js";

function effectiveAgentConfiguration(config: RuntimeConfig): RuntimeConfig {
  if (!config.requestRunner?.configPath) return config;
  const runnerConfig = loadRequestRunnerConfig({ configPath: config.requestRunner.configPath });
  return { ...config, models: createRequestModelPolicy({ platformPolicy: config.models, runnerConfig }) };
}
async function ensureABot(store: FileAgentStateStore, config: RuntimeConfig): Promise<void> {
  const state = await store.read();
  if (state.agents.some((entry) => entry.id === "abot")) return;
  const profileId = config.models?.defaults?.profileId;
  if (!profileId) throw new Error("agents_model_configuration_required");
  const definition = createAgentModelBinding(config).define({ name: "ABot", icon: "pebbles-mint", modelProfileId: profileId,
    toolPermissionMode: "ask", basePrompt: "You are ABot, the user's coordinator. Understand the user's request, consult the available Agent catalog, and delegate bounded assignments to an appropriate available Agent. Read their replies and report established results. You may also use your own work sessions. Other Agents' context stays private. Never invent progress, approval, available budget or completion." });
  try { await store.commit({ kind: "register_agent", agentId: "abot", definition }, state.revision); }
  catch (error) {
    // Concurrent first views can establish the same reserved identity, never run work.
    if ((await store.read()).agents.some((entry) => entry.id === "abot")) return;
    throw error;
  }
}

type WorkspaceServices = Pick<RuntimeEnvironmentServices, "config" | "sessions" | "attachments">;
export function createAgentWorkspaceHost(services: WorkspaceServices, requests: RuntimeRequestHandler,
  changed: (revision: number) => void, runTick?: (operation: () => Promise<void>) => Promise<void>) {
  const config = effectiveAgentConfiguration(services.config);
  const directory = join(config.paths.runtimeDir, "agents");
  const store = new FileAgentStateStore(join(directory, "state.json"));
  const work = createOrdinaryAgentSessionPort({ sessions: services.sessions, requests });
  const coordination = createAgentCoordinationPort({ store, application: () => application });
  const dependencies = { store, config, models: createDefaultModelGatewayClient(config), work, ...coordination };
  const application: ReturnType<typeof createAgentApplication> = createAgentApplication(dependencies);
  const progress = createAgentProgressReporter(dependencies, createAgentChatUpdates(services.sessions));
  let lastRevision: number | undefined;
  const observer = createAgentApplicationObserver({ application, runTick,
    onSnapshot: async (revision, agents) => {
      progress.observe(agents);
      if (revision !== lastRevision || agents.some(detail => detail.status === "working" || detail.status === "thinking" || detail.status === "awaiting_approval")) {
        lastRevision = revision;
        changed(revision);
      }
    }, onError: () => console.error("Agent receipt observer needs attention.") });
  const schedules = createAgentScheduleService({ filename: join(directory, "schedules.json"), application, runTick,
    onError: () => console.error("Agent schedule service needs attention.") });
  const cleanup = createAgentWebCleanup(directory);
  const projection = {
    async notifications(cursor: AgentNotificationCursor, since: number) {
      const state = await store.read();
      const waits = await readAgentNotificationApprovals(state, services.sessions);
      // A cancellation can commit while reading ordinary waits. Project against current ownership/state.
      return projectAgentNotifications(await store.read(), cursor, since, waits);
    },
    async attention(cursors: readonly AgentAttentionCursor[], since: number) {
      return projectAgentAttention(await store.read(), cursors, since);
    },
    async through(agentId: string, through: string) {
      return attentionMessageIdsThrough(await application.detail(agentId), through);
    },
    async pending() {
      const receipts = await cleanup.pending();
      if (!receipts.length) return [];
      const state = await store.read();
      return receipts.filter(receipt => wasAgentDeleted(state, receipt.agentId));
    },
    async acknowledge(id: string) {
      if (!wasAgentDeleted(await store.read(), id)) throw new Error("agents_deletion_unresolved");
      await cleanup.acknowledge(id);
    },
  };
  const deletion = createAgentDeletion({ directory, store, sessions: services.sessions, attachments: services.attachments,
    removeSchedules: schedules.removeForAgent,
    forgetSession: async () => {},
    async forgetAgent(id) {
      const { sessions } = await store.read();
      await cleanup.record(id, sessions.filter(binding => binding.agentId === id).map(binding => binding.sessionId));
    },
    onRecoveryError: () => console.error("An Agent deletion is pending. Retry deletion in the Agents workspace."),
  });
  let stopping: Promise<void> | undefined;
  const approvals = createAgentWorkspaceApprovals(application, work, services.sessions);
  return { store, approvals, application, schedules, deletion, projection, management: createAgentManagementService(store, config),
    async start() {
      await ensureABot(store, config);
      await deletion.recover();
      await application.recover();
      await schedules.start();
      await observer.start();
    },
    isBusy: () => application.isBusy() || deletion.isBusy() || progress.isBusy(),
    stop() {
      stopping ??= (async () => {
        await Promise.all([observer.stop(), schedules.stop(), deletion.stop(), progress.stop(), application.shutdown()]);
      })();
      return stopping;
    },
  };
}
