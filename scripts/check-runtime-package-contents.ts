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
  "dist/scripts/add-runtime-model.js",
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
const maxFileCount = 1579;
const maxUnpackedSizeBytes = 5_108_916;

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
