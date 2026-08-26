export const PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const PUBLIC_SNAPSHOT_FILE_NAME = "PUBLIC-SNAPSHOT.json";

export const PUBLIC_ROOT_OVERLAYS = Object.freeze({
  ".env.example": [
    "# Optional credentials for providers and integrations you explicitly configure.",
    "OPENAI_API_KEY=",
    "BRAVE_SEARCH_API_KEY=",
    "",
    "# Optional process-level runtime overrides.",
    "AGENT_BRIDGE_TOKEN=",
    "LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json",
    "LLM_RUNTIME_SHARED_DIR=",
    "NODE_ENV=development",
    "",
  ].join("\n"),
  ".gitignore": [
    "node_modules/",
    "dist/",
    "coverage/",
    ".runtime/",
    "local/",
    "/workspace/",
    "logs/",
    "sandbox/",
    "/sessions/",
    "/memory/",
    "/skills/",
    ".codex/",
    ".codex-delegate/",
    ".env",
    ".env.*",
    "!.env.example",
    "runtime.config.json",
    "runtime.config.local.json",
    "*.log",
    "*.tmp",
    "*.bak",
    "*:Zone.Identifier",
    "",
  ].join("\n"),
} as const);

export type PublicRootOverlayPath = keyof typeof PUBLIC_ROOT_OVERLAYS;

export const PUBLIC_PLUGIN_IDS = Object.freeze([
  "capability-brief",
  "code-outline",
  "document-reader",
  "exec",
  "filesystem",
  "json-inspector",
  "local-search",
  "memory",
  "project-orientation",
  "system-probe",
  "web",
] as const);

export type PublicPluginId = (typeof PUBLIC_PLUGIN_IDS)[number];

export const PUBLIC_PLUGIN_CAPABILITY_IDS = Object.freeze([
  "capability_brief",
  "inspect_code_outline",
  "document_reader",
  "exec",
  "exec_wait",
  "exec_cancel",
  "dev_view",
  "edit_file",
  "read_file",
  "write_file",
  "inspect_json",
  "local_search",
  "memory_get",
  "memory_search",
  "memory_add",
  "memory_delete",
  "inspect_project",
  "system_probe",
  "web_fetch",
  "web_search",
] as const);

export const PUBLIC_PACKAGE_SCRIPT_NAMES = Object.freeze([
  "init",
  "add-model",
  "dev",
  "web-ui",
  "web-ui:install-user-services",
  "model-gateway",
  "test",
  "clean:dev-state",
  "build",
  "typecheck:plugins",
  "build:plugins",
  "check:plugin-build",
  "clean-dist",
  "copy-build-assets",
  "smoke:runtime-package",
  "smoke:packed-runtime-package",
  "check:runtime-package",
  "check:plugins",
  "check:publication",
  "check:model-step-registry",
  "validate",
  "build-config-schema",
  "generate:model-step-registry",
] as const);

export const PUBLIC_PACKAGE_SCRIPT_OVERRIDES = Object.freeze({
  "check:publication": "tsx scripts/check-publication-readiness.ts",
  validate:
    "npm run check:plugin-build && npm test -- --run && npm run build && npm run check:plugins && npm run smoke:runtime-package && npm run check:runtime-package && npm run smoke:packed-runtime-package && npm run check:publication",
} as const);

export const PUBLIC_SCRIPT_FILES = Object.freeze([
  "scripts/add-runtime-model.ts",
  "scripts/check-publication-readiness.ts",
  "scripts/check-plugins.ts",
  "scripts/check-runtime-package-contents.ts",
  "scripts/build-public-plugins.ts",
  "scripts/clean-dev-state.ts",
  "scripts/clean-dist.ts",
  "scripts/copy-build-assets.ts",
  "scripts/init-runtime.ts",
  "scripts/install-runtime-web-ui-user-services.ts",
  "scripts/runtime-setup-files.ts",
  "scripts/runtime-setup-presentation.ts",
  "scripts/runtime-service-web-ui.ts",
  "scripts/smoke-packed-runtime-package.ts",
  "scripts/smoke-runtime-package-import.ts",
  "scripts/write-model-step-registry.ts",
  "scripts/write-runtime-config-schema.ts",
] as const);

export const PUBLIC_DOCUMENTATION_FILES = Object.freeze([
  "docs/architecture.md",
  "docs/bridge-compatibility.md",
  "docs/configuration.md",
  "docs/installation.md",
  "docs/known-limitations.md",
  "docs/plugins.md",
  "docs/publishing.md",
  "docs/running-locally.md",
  "docs/runtime-invariant-coverage.md",
  "docs/runtime-library.md",
  "docs/runtime-prompt-policy-contracts.md",
  "docs/runtime-public-contracts.md",
  "docs/tool-execution-result-evidence-contract.md",
  "docs/troubleshooting.md",
] as const);

const PUBLIC_PACKAGE_NON_PLUGIN_FILES = [
  "dist/scripts/",
  "dist/src/cli/",
  "dist/src/runtime/",
  "dist/src/bridge/",
  "dist/src/sessions/",
  "dist/src/shared/",
  "dist/src/capabilities/",
  "dist/src/workspace/",
  "dist/src/model-gateway/",
  "dist/src/plugin-contract/",
  "dist/src/plugin-sdk/",
  "dist/src/web-ui/",
  "runtime.config.schema.json",
  "src/runtime/README.md",
  "LICENSE",
  ...PUBLIC_DOCUMENTATION_FILES,
  "examples/minimal-runtime-composition.ts",
  "examples/runtime-library-host.ts",
  "examples/runtime.config.example.json",
  "examples/env.example",
  "examples/models/",
  "examples/request-runner.config.example.json",
] as const;

export const PUBLIC_PACKAGE_FILES = Object.freeze([
  ...PUBLIC_PACKAGE_NON_PLUGIN_FILES,
  ...PUBLIC_PLUGIN_IDS.map((pluginId) => `plugins/${pluginId}/`),
]);

export const REQUIRED_PUBLIC_SOURCE_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "agent-bridge.ts",
  "index.ts",
  "package-lock.json",
  "package.json",
  "public-snapshot.manifest.json",
  "runtime.config.schema.json",
  "tsconfig.build.json",
  "tsconfig.plugins.json",
  "tsconfig.json",
  "vitest.config.ts",
  "systemd/user/abot-llm-runtime-web-ui-open-v1.service.in",
  "systemd/user/abot-llm-runtime-web-ui-v1.service.in",
  "scripts/public-snapshot/check-public-snapshot.ts",
  "scripts/public-snapshot/cli-args.ts",
  "scripts/public-snapshot/content-scan.ts",
  "scripts/public-snapshot/contracts.ts",
  "scripts/public-snapshot/filesystem.ts",
  "scripts/public-snapshot/git-tracked.ts",
  "scripts/public-snapshot/index.ts",
  "scripts/public-snapshot/manifest.ts",
  "scripts/public-snapshot/package-transform.ts",
  "scripts/public-snapshot/snapshot.ts",
  "scripts/public-snapshot/stable-json.ts",
  "src/runtime/__tests__/public-runtime-config-fixture.ts",
  "src/runtime/__tests__/public-snapshot.test.ts",
  ...PUBLIC_DOCUMENTATION_FILES,
  ...PUBLIC_SCRIPT_FILES,
] as const);

export const REQUIRED_PUBLIC_DIRECTORIES = Object.freeze([
  "examples",
  "methodologies",
  "src",
  ...PUBLIC_PLUGIN_IDS.map((pluginId) => `plugins/${pluginId}`),
]);

export const REQUIRED_PUBLIC_SNAPSHOT_FILES = Object.freeze([
  ...Object.keys(PUBLIC_ROOT_OVERLAYS),
  ...REQUIRED_PUBLIC_SOURCE_FILES,
]);

export type PublicSnapshotManifest = Readonly<{
  schemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA_VERSION;
  directories: readonly string[];
  files: readonly string[];
  plugins: readonly PublicPluginId[];
}>;

export type PublicSnapshotFileRecord = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

export type PublicSnapshotRecord = Readonly<{
  schemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA_VERSION;
  manifestSha256: string;
  plugins: readonly PublicPluginId[];
  treeSha256: string;
  files: readonly PublicSnapshotFileRecord[];
}>;
