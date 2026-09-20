import { execFileSync } from "node:child_process";

import { PUBLIC_PLUGIN_IDS } from "./public-snapshot/contracts.js";
import { assertExactPublicPluginPackagePaths } from "./public-snapshot/package-transform.js";

type PackFile = {
  path: string;
  size: number;
};

type PackResult = {
  files: PackFile[];
};

function fail(message: string): never {
  throw new Error(message);
}

function runPackDryRun(): PackResult {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output) as PackResult[];
  return parsed[0] ?? fail("npm pack --dry-run returned no package result");
}

const pack = runPackDryRun();
const paths = pack.files.map((file) => file.path).sort();

assertExactPublicPluginPackagePaths(paths);

const forbiddenPatterns = [
  /^\.env($|\.)/,
  /\.map$/,
  /(^|\/)__tests__(\/|$)/i,
  /\.test\./,
  /^runtime\.config\.json$/,
  /^runtime\.config\.local\.json$/,
];

for (const path of paths) {
  const forbidden = forbiddenPatterns.find((pattern) => pattern.test(path));
  if (forbidden) {
    fail(`package includes forbidden artifact: ${path}`);
  }
}

const requiredPaths = [
  "dist/src/cli/host-companion.js",
  "dist/src/cli/host-companion.d.ts",
  "dist/src/cli/host-companion-bundle.mjs",
  "dist/src/cli/host-companion-entry.js",
  "dist/src/web-ui/system-host-setup/installers.js",
  "dist/src/web-ui/system-host-setup/readiness.js",
  "dist/src/web-ui/system-host-setup/routes.js",
  "dist/src/web-ui/system-host-service.js",
  "dist/plugins/system/source/companion/native-session.js",
  "dist/plugins/system/source/companion/native-supervisor.js",
  "dist/plugins/system/source/companion/native-state.js",
  "dist/plugins/system/source/companion/autostart.js",
  "dist/plugins/system/source/companion/broker-server.js",
  "dist/plugins/system/source/companion/pairing-store.js",
  "dist/plugins/system/source/companion/protocol.js",
  "dist/src/web-ui/app/components/system-host/manager.js",
  "dist/src/web-ui/app/components/system-host/rendering.js",
  "dist/src/web-ui/app/services/runtime-web-client/system-host.js",
  "dist/src/web-ui/app/styles/46-system-host.css",
  "dist/src/capabilities/tool-definition-validator/event-input-text-options.d.ts",
  "dist/src/capabilities/tool-definition-validator/event-input-text-options.js",
  "dist/src/capabilities/tool-event-input-text.d.ts",
  "dist/src/capabilities/tool-event-input-text.js",
  "dist/src/web-ui/app/components/conversation-tool-evidence.d.ts",
  "dist/src/web-ui/app/components/conversation-tool-evidence.js",
  "dist/src/web-ui/app/lib/tool-process-activity-fields.js",
  ...[
    "capabilities/tool-permission-mode",
    "runtime/capabilities/request-permission-catalog",
    "runtime/capabilities/request-permission-tool-registry",
    "runtime/capabilities/request-working-directory",
    "runtime/plugins/runtime-capability-plugins",
    "runtime/projects/contracts",
    "runtime/projects/folders",
    "runtime/projects/repository",
    "runtime/projects/service",
    "runtime/projects/session-paths",
    "sessions/project-binding",
    "web-ui/local-runtime/project-routes",
  ].flatMap((name) => [
    "dist/src/" + name + ".js",
    "dist/src/" + name + ".d.ts",
  ]),
  "dist/src/web-ui/app/app-state.js",
  "dist/src/web-ui/app/components/project-creation.js",
  "dist/src/web-ui/app/components/project-session-groups.js",
  "dist/src/web-ui/app/controllers/projects-controller.js",
  "dist/src/web-ui/app/controllers/projects-controller.d.ts",
  "dist/src/web-ui/app/controllers/tool-permission-mode-controller.js",
  "dist/src/web-ui/app/controllers/tool-permission-mode-controller.d.ts",
  "dist/src/web-ui/app/lib/tool-permission-mode.js",
  "dist/src/web-ui/app/lib/tool-permission-mode.d.ts",
  "dist/src/web-ui/app/projects-feature.js",
  "dist/src/web-ui/app/services/client-preferences.d.ts",
  "dist/src/web-ui/app/services/runtime-web-client/projects.js",
  "dist/src/web-ui/app/services/runtime-web-client/projects.d.ts",
  "dist/src/web-ui/app/styles/13-projects.css",
  "plugins/system/skills/system_actions/SKILL.md",
  "docs/projects-and-full-plus.md",
  "dist/src/capabilities/file-output-presentation.js",
  "dist/src/capabilities/file-output-presentation.d.ts",
  "dist/src/runtime/capabilities/file-output-root-identity.js",
  "dist/src/runtime/capabilities/file-output-root-identity.d.ts",
  "dist/src/runtime/capabilities/file-output-root-marker-creation.js",
  "dist/src/runtime/capabilities/file-output-root-marker-creation.d.ts",
  "dist/src/runtime/adapters/registered-tool-normal-invocations/execution/file-output-presentation.js",
  "dist/src/web-ui/local-runtime/conversation-file-routes.js",
  "dist/src/web-ui/local-runtime/conversation-file-access.js",
  "dist/src/web-ui/local-runtime/conversation-file-target.js",
  "dist/src/web-ui/local-runtime/conversation-file-native-request.js",
  "dist/src/web-ui/local-runtime/conversation-file-native-open.js",
  "dist/src/web-ui/app/components/conversation-file-preview.js",
  "dist/src/web-ui/app/controllers/conversation-view-feature.js",
  "dist/src/web-ui/app/styles/29-conversation-file-preview.css",
  "dist/src/runtime/adapters/config-file-transaction.js",
  "dist/src/web-ui/environment-config.js",
  "dist/src/web-ui/config-dashboard-model-identity.js",
  "dist/src/web-ui/local-runtime/runtime-setup-environment-assignment.js",
  "dist/src/web-ui/local-runtime/provider-credential-identity.js",
  "dist/src/web-ui/app/components/runtime-setup/embedding-provider-receipt.js",
  "dist/src/web-ui/config-dashboard-save-transaction.js",
  "dist/src/web-ui/local-runtime/configuration-activation-environments.js",
  "dist/src/web-ui/request-authority.js",
  "dist/src/web-ui/runtime-setup-gateway-address.js",
  "dist/src/web-ui/runtime-setup-shutdown.js",
  "dist/src/web-ui/app/runtime-setup-page-lifecycle.js",
  "dist/src/web-ui/app/configuration-environment-refresh.js",
  "dist/src/web-ui/app/components/runtime-setup/context-window.js",
  "dist/src/web-ui/app/components/runtime-setup/bridge-guide.js",
  "dist/src/web-ui/app/components/runtime-setup/bridge-rendering.js",
  "dist/src/web-ui/app/styles/45-bridge-setup.css",
  ...[
    "model-setup-input",
    "model-setup-catalog",
    "model-setup-provider",
    "model-setup-validation",
    "model-setup-service",
    "model-setup-routes",
    "runtime-setup-service",
    "runtime-setup-scaffold",
    "runtime-setup-credentials",
    "runtime-setup-validation",
    "runtime-setup-routes",
    "setup-embedding-input",
    "setup-embedding-provider",
    "setup-embedding-service",
    "setup-embedding-routes",
    "configuration-activation",
    "plugin-management-routes",
    "config-mutation-request",
  ].map((name) => "dist/src/web-ui/local-runtime/" + name + ".js"),
  "dist/src/web-ui/runtime-setup-gateway.js",
  "dist/src/web-ui/plugin-management-service.js",
  "dist/src/web-ui/plugin-management-catalog.js",
  "dist/src/web-ui/plugin-capability-selection.js",
  "dist/src/runtime/plugins/configured-manifests.js",
  "dist/src/runtime/plugins/selection.js",
  ...[
    "model-setup/wizard",
    "model-setup/rendering",
    "model-setup/validation",
    "model-setup/save-flow",
    "model-setup/save-outcome",
    "runtime-setup/connection-form",
    "runtime-setup/configuration-recovery",
    "runtime-setup/wizard-shell",
    "config-workspace/model-setup-entry",
    "config-workspace/raw-config-repair",
  ].map((name) => "dist/src/web-ui/app/components/" + name + ".js"),
  "dist/src/web-ui/app/styles/43-model-setup.css",
  "dist/src/web-ui/app/styles/44-model-provider-cards.css",
  "dist/src/web-ui/app/components/runtime-setup/rendering.js",
  "dist/src/web-ui/app/components/runtime-setup/validation.js",
  "dist/src/web-ui/app/runtime-onboarding-feature.js",
  "dist/src/web-ui/app/components/runtime-setup/embedding.js",
  "dist/src/web-ui/app/components/runtime-setup/embedding-rendering.js",
  "dist/src/web-ui/app/components/runtime-setup/plugins.js",
  "dist/src/web-ui/app/components/runtime-setup/view-state.js",
  "dist/src/web-ui/app/components/runtime-config-activation.js",
  "dist/src/web-ui/app/components/plugins/manager.js",
  "dist/src/web-ui/app/components/plugins/view-state.js",
  "dist/src/web-ui/app/services/runtime-web-client/configuration.js",
  "dist/src/web-ui/app/styles/19-runtime-setup.css",
  "dist/src/web-ui/app/styles/37-runtime-activation.css",
  "dist/src/web-ui/app/styles/41-plugin-management.css",
  "dist/src/web-ui/app/styles/42-runtime-setup-plugins.css",
  "src/runtime/scheduler/README.md",
  "src/runtime/local-host/README.md",
  "dist/scripts/add-runtime-model.js",
  "dist/scripts/runtime-model-addition.js",
  "dist/scripts/configure-long-term-memory.js",
  "dist/scripts/init-runtime.js",
  "dist/scripts/runtime-setup-files.js",
  "dist/src/cli/abot.js",
  "dist/src/cli/bin.js",
  "dist/src/runtime/index.js",
  "dist/src/runtime/index.d.ts",
  "dist/src/runtime/adapters/index.js",
  "dist/src/runtime/adapters/index.d.ts",
  "dist/src/runtime/adapters/in-memory-session-store.js",
  "dist/src/runtime/adapters/in-memory-session-store.d.ts",
  "dist/src/runtime/adapters/multi-workspace-provider.js",
  "dist/src/runtime/adapters/multi-workspace-provider.d.ts",
  "dist/src/runtime/config.js",
  "dist/src/runtime/config.d.ts",
  "dist/src/runtime/config/builders.js",
  "dist/src/runtime/config/builders.d.ts",
  "dist/src/runtime/config/schema.js",
  "dist/src/runtime/config/schema.d.ts",
  "dist/src/runtime/config/validation.js",
  "dist/src/runtime/config/validation.d.ts",
  "dist/src/runtime/config/runner/config-normalization.js",
  "dist/src/runtime/config/runner/config-normalization.d.ts",
  "dist/src/runtime/config/runner/schema-version.js",
  "dist/src/runtime/config/runner/schema-version.d.ts",
  "dist/src/runtime/config/runner/versioned-config.js",
  "dist/src/runtime/config/runner/versioned-config.d.ts",
  "dist/src/runtime/composition.js",
  "dist/src/runtime/composition.d.ts",
  ...[
    "runtime/config/environment-paths",
    "runtime/config/environment-storage",
    "runtime/default-environment-adapters",
    "runtime/runtime-environment",
    "runtime/runtime-host",
    "runtime/runtime-host-environment",
    "runtime/runtime-host-lifecycle",
    "runtime/runtime-host-scheduler-ownership",
    "runtime/request/bound-runtime-handler",
    "runtime/request/scheduled-execution",
    "runtime/capabilities/scheduling/create-time-zone",
    "runtime/capabilities/scheduling/model-validation",
    "runtime/capabilities/scheduling/job-list-page",
    "runtime/capabilities/scheduling/create-operations",
    "runtime/capabilities/scheduling/update-operations",
    "runtime/capabilities/scheduling/tool-input-properties",
    "runtime/local-host/startup-connection",
    "runtime/local-application",
    "runtime/local-host/app-owner",
    "runtime/local-host/app-request-control",
    "runtime/local-host/app-service-dispatch",
    "runtime/local-host/app-memory-dispatch",
    "runtime/local-host/client-identity",
    "runtime/local-host/client-memory",
    "runtime/local-host/client-requests",
    "runtime/local-host/client-services",
    "runtime/local-host/contracts",
    "runtime/local-host/endpoint",
    "runtime/local-host/owner-server",
    "runtime/local-host/owner-activity",
    "runtime/local-host/owner-retirement",
    "runtime/adapters/long-term-memory/file-lock/synchronous-release",
    "runtime/local-host/private-access",
    "runtime/local-host/private-directory",
    "runtime/local-host/rpc-peer",
    "runtime/local-host/rpc-protocol",
    "runtime/local-host/transport",
    "runtime/local-host/windows-private-access",
    "runtime/scheduler/contracts",
    "runtime/scheduler/scheduler-service",
    "runtime/scheduler/session-deletion-state",
    "runtime/scheduler/schedule-update",
    "runtime/scheduler/run-completion",
    "runtime/scheduler/interval-range",
    "runtime/scheduler/run-list-query",
    "runtime/scheduler/file-store",
    "runtime/scheduler/journal-files",
    "runtime/scheduler/journal-head",
    "runtime/scheduler/journal-checkpoint",
    "runtime/scheduler/journal-durability",
    "runtime/scheduler/journal-index-state",
    "runtime/scheduler/journal-index",
    "runtime/scheduler/journal-store",
    "runtime/scheduler/journal-transaction",
    "runtime/scheduler/working-store",
    "runtime/adapters/scheduler-runtime",
    "runtime/adapters/scheduled-request-outcome",
    "runtime/capabilities/scheduling/tool-contract",
    "runtime/capabilities/scheduling/tool-module",
    "runtime/request/session-admission",
    "runtime/session/session-lifecycle-store",
    "runtime/session/session-deletion-cleanup",
    "runtime/session/session-deletion-receipts",
    "runtime/session/session-attachment-deletion",
    "runtime/session/session-deletion-boundary",
    "runtime/session/session-deletion-finalization",
    "runtime/session/session-mutation-queue",
    "sessions/schedule-metadata",
    "shared/http-server-shutdown",
    "web-ui/local-runtime/schedule-management-routes",
    "web-ui/local-runtime/schedule-run-page",
    "web-ui/local-runtime/schedule-job-creation",
    "web-ui/schedule-creation-contract",
    "web-ui/local-runtime/session-routes",
    "web-ui/session-read-state/store",
    "web-ui/session-read-state/projection",
    "web-ui/session-read-state/service",
    "web-ui/session-read-state/availability",
    "web-ui/server-shutdown",
  ].flatMap((modulePath) => [
    `dist/src/${modulePath}.js`,
    `dist/src/${modulePath}.d.ts`,
  ]),
  "dist/src/plugin-contract/index.js",
  "dist/src/plugin-contract/index.d.ts",
  "dist/src/plugin-sdk/index.js",
  "dist/src/plugin-sdk/index.d.ts",
  ...[
    "plugin-sdk/tool-availability-brief",
    "plugin-sdk/tool-availability-overview",
    "runtime/capabilities/tool-availability",
    "runtime/context/capability-brief",
    "runtime/request/capability-brief",
    "runtime/steps/supervisor-decision/capability-brief",
  ].flatMap((modulePath) => [
    `dist/src/${modulePath}.js`,
    `dist/src/${modulePath}.d.ts`,
  ]),
  "dist/src/model-gateway/index.js",
  "dist/src/model-gateway/index.d.ts",
  "dist/src/model-gateway/provider-adapter.js",
  "dist/src/model-gateway/provider-adapter.d.ts",
  "dist/src/model-gateway/server.js",
  "dist/src/model-gateway/server.d.ts",
  "dist/src/model-gateway/message-contract.js",
  "dist/src/model-gateway/message-contract.d.ts",
  "dist/src/model-gateway/invocation-policy.js",
  "dist/src/model-gateway/invocation-policy.d.ts",
  "dist/src/model-gateway/invocation-profile-policy.js",
  "dist/src/model-gateway/invocation-profile-policy.d.ts",
  "dist/src/model-gateway/model-registry.js",
  "dist/src/model-gateway/model-registry.d.ts",
  "dist/src/model-gateway/types.js",
  "dist/src/model-gateway/types.d.ts",
  "dist/src/shared/invocation-profile-selection.js",
  "dist/src/shared/invocation-profile-selection.d.ts",
  "dist/src/shared/types.js",
  "dist/src/shared/types.d.ts",
  "dist/src/web-ui/server.js",
  "dist/src/web-ui/app/index.html",
  "dist/src/web-ui/app/app.js",
  "dist/src/web-ui/app/components/conversation-status.js",
  "dist/src/web-ui/app/lib/conversation-status-model.js",
  "dist/src/web-ui/app/lib/conversation-status-model.d.ts",
  "dist/src/web-ui/app/lib/context-window-snapshot-order.js",
  "dist/src/web-ui/app/lib/context-window-snapshot-order.d.ts",
  "dist/src/web-ui/app/styles/28-conversation-status.css",
  ...[
    "app-dom.js",
    "app-bootstrap.js",
    "configuration-feature.js",
    "dashboard-feature.js",
    "components/dashboard/activity.js",
    "components/dashboard/icons.js",
    "components/dashboard/recent-conversations.js",
    "components/dashboard/workspace.js",
    "controllers/composer-surface-controller.js",
    "controllers/composer-workspace-controller.js",
    "controllers/composer-workspace-controller.d.ts",
    "controllers/conversation-read-state-controller.js",
    "controllers/conversation-read-state-controller.d.ts",
    "controllers/dashboard-controller.js",
    "controllers/home-composer-feature.js",
    "controllers/home-composer-feature.d.ts",
    "controllers/home-conversation-activation.js",
    "lib/composer-submission-scope.js",
    "lib/composer-submission-scope.d.ts",
    "lib/dashboard-job-templates.js",
    "lib/dashboard-presentation.js",
    "lib/session-read-state.js",
    "lib/session-read-state.d.ts",
    "styles/18-dashboard.css",
    "styles/92-dashboard-responsive.css",
    "schedules-feature.js",
    "components/conversation-schedule.js",
    "components/schedules/details.js",
    "components/schedules/form.js",
    "components/schedules/form.d.ts",
    "components/schedules/workspace.js",
    "components/schedules/workspace-state.js",
    "controllers/schedule-realtime.js",
    "controllers/schedules-controller.js",
    "lib/schedule-message.js",
    "lib/schedule-errors.js",
    "lib/schedule-presentation.js",
    "services/runtime-web-client/schedules.js",
    "styles/38-schedules.css",
    "styles/38-schedule-workspace.css",
    "styles/91-schedules-responsive.css",
  ].map((assetPath) => `dist/src/web-ui/app/${assetPath}`),
  "dist/src/web-ui/app/components/composer-plan.js",
  "dist/src/web-ui/app/components/composer-plan.d.ts",
  "dist/src/web-ui/app/lib/composer-plan-model.js",
  "dist/src/web-ui/app/lib/composer-plan-model.d.ts",
  "dist/src/web-ui/app/lib/task-progress.js",
  "dist/src/web-ui/app/lib/task-progress.d.ts",
  "dist/src/web-ui/app/styles/23-composer-plan.css",
  "dist/src/web-ui/app/components/conversation-role-cards.js",
  "dist/src/web-ui/app/components/conversation-role-cards.d.ts",
  "dist/src/web-ui/app/lib/conversation-role-model.js",
  "dist/src/web-ui/app/lib/conversation-role-model.d.ts",
  "dist/src/web-ui/app/styles/24-conversation-role-cards.css",
  "dist/src/web-ui/app/components/conversation-sources.js",
  "dist/src/web-ui/app/components/conversation-sources.d.ts",
  "dist/src/web-ui/app/lib/web-sources.js",
  "dist/src/web-ui/app/lib/web-sources.d.ts",
  "dist/src/web-ui/app/lib/source-url-policy.js",
  "dist/src/web-ui/app/lib/source-url-policy.d.ts",
  "dist/src/web-ui/app/lib/web-source-event.js",
  "dist/src/web-ui/app/lib/web-source-event.d.ts",
  "dist/src/web-ui/app/styles/25-conversation-sources.css",
  "dist/src/web-ui/app/lib/message-markdown.js",
  "dist/src/web-ui/app/components/message-link-previews.js",
  "dist/src/web-ui/app/services/message-link-preview-client.js",
  "dist/src/web-ui/app/styles/26-message-content.css",
  ...[
    "capabilities/tool-definition-validator/event-result-metadata",
    "capabilities/tool-result-event-projection",
    "runtime/adapters/registered-tool-normal-invocations/execution/rejection-event",
    "web-ui/app/components/conversation-tools",
    "web-ui/app/lib/tool-activity-event",
    "web-ui/app/lib/tool-activity-model",
    "web-ui/app/lib/tool-timeline",
  ].flatMap((modulePath) => [
    `dist/src/${modulePath}.js`,
    `dist/src/${modulePath}.d.ts`,
  ]),
  "dist/src/web-ui/app/styles/27-conversation-tools.css",
  "dist/src/web-ui/app/vendor/markdown-it.js",
  "dist/src/web-ui/app/vendor/markdown-it.LICENSE",
  "dist/src/web-ui/link-preview/routes.js",
  "dist/src/shared/public-http/public-http.js",
  "dist/src/shared/model-step-registry-data.json",
  "README.md",
  "LICENSE",
  "docs/architecture.md",
  "docs/installation.md",
  "docs/configuration.md",
  "docs/running-locally.md",
  "docs/bridge-compatibility.md",
  "docs/known-limitations.md",
  "docs/long-term-memory.md",
  "docs/plugins.md",
  "docs/troubleshooting.md",
  "docs/publishing.md",
  "docs/runtime-library.md",
  "docs/runtime-public-contracts.md",
  "docs/tool-execution-result-evidence-contract.md",
  "docs/runtime-prompt-policy-contracts.md",
  "docs/runtime-invariant-coverage.md",
  "methodologies/response-ux.md",
  "methodologies/memory-informed-response.md",
  "examples/minimal-runtime-composition.ts",
  "examples/runtime-library-host.ts",
  "examples/runtime.config.example.json",
  "examples/env.example",
  "examples/models/default.config.json",
  "examples/request-runner.config.example.json",
  ...PUBLIC_PLUGIN_IDS.flatMap((pluginId) => [
    `plugins/${pluginId}/plugin.json`,
    `plugins/${pluginId}/src/index.cjs`,
  ]),
  "runtime.config.schema.json",
];

for (const requiredPath of requiredPaths) {
  if (!paths.includes(requiredPath)) {
    fail(`package is missing required artifact: ${requiredPath}`);
  }
}

const totalSize = pack.files.reduce((sum, file) => sum + file.size, 0);
// Keep this as a tight publication guardrail, not an exact architecture
// contract. Each emitted runtime module contributes both .js and .d.ts files,
// so legitimate production modules can move the count by more than one.
// The model-gateway topic split adds 55 emitted modules. TypeScript publishes
// both JavaScript and declaration files, so preserve the existing guardrail
// headroom while accounting for those 110 intentional package artifacts. The
// session-memory feature adds 17 focused modules, or 34 emitted artifacts.
// Passive long-term memory adds 41 focused production modules. TypeScript emits
// JavaScript and declarations for each, while the Web UI and documentation add
// three package assets. Canonical memory management then adds seven net
// production modules (14 emitted artifacts), and its management API/UI adds six
// emitted artifacts plus ten browser assets. Capability reconsideration adds
// nine focused production modules, or 18 emitted artifacts. Generic operation
// supervision then replaces four production modules with 14 focused modules,
// for a net 10 modules or 20 emitted package artifacts. Preserve the existing
// 24-file guardrail headroom after accounting for those intentional additions.
// Runtime config validation then replaces one module with 11 focused modules,
// adding 10 net modules or 20 emitted artifacts. The Execution Agent control
// contract adds one further packaged module. Worker decision parsing now keeps
// its existing facade and adds eight responsibility-owned modules, or 16 exact
// emitted artifacts. Tool definition validation likewise keeps its facade and
// adds eight responsibility-owned modules, or 16 exact emitted artifacts, so
// keep the bound at the resulting 1,403-file baseline. Config Workspace then
// keeps its browser facade and adds nine focused browser modules, which are
// copied as nine package assets. Role-call command dispatch then keeps its
// facade and adds 12 focused production modules, or 24 emitted artifacts.
// Worker capability execution and binding retain both facades and add 15
// responsibility-owned modules, or 30 exact emitted artifacts.
// Request Runner Config v2 keeps the loader facade and adds three focused
// modules, or six exact JavaScript and declaration artifacts.
// Planner and Reviewer stabilization adds nine focused production modules,
// or 18 exact JavaScript and declaration artifacts. Worker payload source
// provenance adds one focused module, or two exact emitted artifacts. Planner
// capability-catalog context adds one focused module, or two emitted artifacts.
// PR1 work-result provenance adds four focused modules, or eight emitted
// artifacts, and raises the measured baseline to 1,502 files and 4,798,102
// unpacked bytes. Keep roughly 8 KiB of headroom instead of weakening either
// publication boundary broadly.
// Compact composer context usage and tool invocation counting add two browser
// modules with declarations plus one stylesheet: five intentional assets.
// The shared capability brief adds six production modules (12 emitted files).
// Account for both additions while preserving the one-file margin. The brief
// adds 10,000 bytes to the size ceiling; the composer change adds no size reserve.
// The Planner drawer adds seven browser assets (three modules with declarations
// and one stylesheet). Its net browser delta is 16,223 bytes. Account only for
// that measured growth, retaining the existing size and one-file margins.
// Review fixes add 2,827 measured browser bytes for replay reconciliation and
// request-bound restoration, with no additional packaged files.
// Readable typography, history separators and RTL add 3,182 CSS bytes.
// Preserve the existing package margins; no packaged files are added.
// Independent Light search adds 29 source files, one selector, and its README:
// 31 package files. The approved sources, bundle, docs, and metadata add exactly
// 193,248 unpacked bytes to the 1,525-file / 4,838,543-byte measured baseline.
// Preserve the existing one-file and 689-byte margins.
// Light review fixes add three source modules for robots directives, charsets,
// and HTTP freshness. The measured package has 1,559 files; retain the same
// one-file and 689-byte margins after including this guard's annotation.
// Compact role activity adds five browser assets. Include only their measured
// net browser growth, preserving the one-file and 689-byte package margins.
// Collapsed role avatars add 2,002 browser bytes with no additional assets.
// Web source receipts add five plugin source modules and nine browser assets.
// Include their measured package growth, retaining one file and 689 bytes of headroom.
// Supervisor recommendations and steering binding add three runtime modules.
// Measured growth from f68dbcfa is six files and 11,691 unpacked bytes.
// Preserve that baseline's actual one-file and 29-byte margins.
// Memory-preparation steering binding adds 764 bytes with no new package files.
// Root memory recall adds eighteen bounded runtime modules (36 compiled files).
// Preserve the existing one-file and 29-byte margins after measured package growth.
// Recall review fixes add 1,816 measured bytes with no new packaged files.
// Preserve the current 342-byte and one-file margins.
// Rich message rendering and previews add 36 packaged files, including the
// locally bundled Markdown parser and shared HTTP transport. The measured
// package is 1,656 files / 5,358,521 bytes; retain one file and 342 bytes of margin.
// Tool activity adds 13 intentional artifacts and 54,772 measured net bytes.
// The package is 1,669 files / 5,413,293 bytes; retain the same margins.
// Review fixes add the rejection-event module's two artifacts and 6,986 net bytes.
// The package is 1,671 files / 5,420,279 bytes; retain the same margins.
// Core scheduling adds 44 emitted module artifacts, 14 browser assets and a README.
// The measured package is 1,730 files / 5,567,616 bytes; preserve the existing
// one-file and 342-byte margins. No private scheduling plugin is included.
// Shared local ownership adds 36 emitted artifacts, three workspace assets and
// a README. The measured package is 1,770 files / 5,640,877 bytes; preserve the
// same one-file and 342-byte margins, with no private or test artifacts.
// Review fixes extract nine focused modules for host composition/lifecycle,
// startup handshakes and schedule validation. Measured: 1,788 files / 5,656,165
// bytes; retain one file and 342 bytes of headroom.
// Owner retirement adds two focused modules (four artifacts). Measured:
// 1,792 files / 5,663,327 bytes; preserve one file and 342 bytes of headroom.
// Verified scheduled outcomes add one focused module (two artifacts). Measured:
// 1,794 files / 5,669,029 bytes; preserve one file and 342 bytes of headroom.
// Synchronous owner-lease cleanup adds two artifacts. Measured: 1,796 files /
// 5,672,004 bytes; preserve one file and 342 bytes of headroom.
// Incremental scheduling and reviewed lifecycle boundaries add 24 artifacts.
// Measured: 1,840 files / 5,745,498 bytes; retain the same existing margins.
// Environment paths and timing/deletion owners add eight artifacts. Measured:
// 1,848 files / 5,757,694 bytes; retain one file and 342 bytes of headroom.
// Conversation activity adds six browser assets. Measured: 1,870 files /
// 5,806,096 bytes; retain one file and 342 bytes of headroom.
// Dashboard and Web UI read state add 24 browser assets and 12 emitted artifacts.
// Compared with the rebuilt 485186dc package (1,870 files / 5,812,022 bytes),
// measured growth is 36 files / 84,539 bytes. The package is 1,906 files /
// 5,896,561 bytes; preserve the existing one-file and 342-byte margins.
// Read-state failure isolation adds two emitted availability artifacts and
// 6,531 net bytes. Measured: 1,908 files / 5,903,092 bytes; retain one file
// and 342 bytes of headroom.
// Guided onboarding, plugin controls and additive models: 2,011 files / 6,175,878 bytes.
// Preserve one file and 512 bytes of measured package headroom.
// Editable onboarding connection: 2,075 files / 6,312,952 bytes.
// Preserve one file and 512 bytes of measured package headroom.
// Conversation file preview: 2,102 files / 6,382,231 bytes, including 26 new
// presentation/API outputs. Preserve one file and 512 bytes of headroom.
// File-preview review fixes: 2,106 files / 6,395,664 bytes, including root
// identity and anchored marker creation. Preserve one file and 512 bytes.
// Mutation-root binding: 2,106 files / 6,400,727 bytes. Preserve the same
// one-file and 512-byte margins; no additional package files.
// Mac file opening and inline filename action: 2,114 files / 6,418,156 bytes.
// Includes four new backend modules; retain one file and 512 bytes of headroom.
// Projects and FULL+ add 54 audited files: 24 core outputs, 16 Web UI/API
// assets, 13 bundled system-plugin files and one feature doc. Measured:
// 2,168 files / 6,570,090 bytes; retain one file and 512 bytes of headroom.
// System evidence adds two sources; generic selection removes two intrinsic outputs.
// Measured: 2,168 files / 6,586,770 bytes. Preserve the preceding measured
// one-file and 189-byte headroom after the catalog-capacity correction.
// Docker host companion adds the native handler import closure, companion sources,
// CLI/Web owners and connection UI. Audited: 2,257 files / 6,850,985 bytes.
// Retain one file and 512 bytes of headroom; no private or test artifacts.
// GUI computer setup adds the exact-build native bundle, bounded installer and
// readiness owners, and shared onboarding assets. Audited: 2,287 files /
// 7,110,430 bytes. Preserve one file and 512 bytes of headroom.
// Luna audit and model-owned plan progress add 17 runtime modules (34 outputs)
// plus two exec source modules: 36 audited package files. Measured: 2,341 files /
// 7,234,011 bytes. Preserve one file and 512 bytes of headroom; all exact-path,
// public-plugin and forbidden-artifact checks above remain unchanged.
// Planner binding/Auditor budgeting and Dev View retain their audited outputs.
// Trusted EXEC removes three lexical-parser sources; exact-action metadata and
// UI disclosure reuse existing owners. Supervisor semantic availability adds
// four emitted artifacts; routing readmission adds two. Planner now shares that
// admission and replaces its old catalog module: two net emitted artifacts.
// Worker intent and system launch guidance reuse existing files; no added paths.
// Measured: 2,353 files / 7,248,979 bytes; retain one file/512 bytes of headroom.
const maxFileCount = 2_354;
const maxUnpackedSizeBytes = 7_249_491;

if (paths.length > maxFileCount) {
  fail(`package includes too many files: ${paths.length} > ${maxFileCount}`);
}
if (totalSize > maxUnpackedSizeBytes) {
  fail(
    `package is too large: ${totalSize} bytes > ${maxUnpackedSizeBytes} bytes`,
  );
}

console.log(
  `runtime package contents ok: ${paths.length} files, ${totalSize} bytes`,
);
