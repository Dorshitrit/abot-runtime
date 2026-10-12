import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { RuntimeSetupService } from "../../../web-ui/local-runtime/runtime-setup-service.js";
import {
  readSetupEditFile,
  type SetupEditFileSnapshot,
} from "../../../web-ui/local-runtime/runtime-setup-edit-files.js";
import { setupEditJournalPath } from "../../../web-ui/local-runtime/runtime-setup-edit-journal.js";

export type SetupEditDiskState = Record<string, SetupEditFileSnapshot>;
export async function createSetupEditFixture(
  options: { credentials?: boolean; customPath?: boolean } = {},
) {
  const artifacts = resolve(".codex/artifacts/abot170-qa-fixes/connection");
  await fs.mkdir(artifacts, { recursive: true });
  const workspace = await fs.mkdtemp(join(artifacts, "transaction-"));
  const rootDir = join(workspace, "runtime");
  await fs.mkdir(rootDir);
  const configPath = options.customPath
    ? join(workspace, "custom config outside root", "runtime.json")
    : join(rootDir, "local/runtime.config.json");
  await fs.mkdir(join(configPath, ".."), { recursive: true });
  const paths = [
    join(configPath, "../models/default.config.json"),
    configPath,
    configPath + ".web-setup.json",
    join(rootDir, ".env"),
  ];
  const journalPath = setupEditJournalPath(rootDir);
  const activate = vi.fn(async () => ({ status: "ready" as const }));
  const service = () =>
    new RuntimeSetupService({
      rootDir,
      getConfigPath: () => configPath,
      activate,
    });
  const input = {
    provider: options.credentials ? "openai" : "ollama",
    model: "old-model",
    ...(options.credentials ? {} : { baseUrl: "http://127.0.0.1:11435" }),
    contextWindowTokens: 32768,
    deferActivation: true,
    ...(options.credentials ? { apiKey: "fixture-old-key" } : {}),
  };
  const initial = await service().save(input);
  const next = {
    ...input,
    model: "new-model",
    ...(options.credentials ? {} : { baseUrl: "http://127.0.0.1:11436" }),
    connectionRevision: initial.setup.editableConnection!.revision,
    ...(options.credentials ? { apiKey: "fixture-new-key" } : {}),
  };
  const readState = async (): Promise<SetupEditDiskState> => {
    const state: SetupEditDiskState = {};
    for (const path of [...paths, journalPath])
      state[path] = await readSetupEditFile(path);
    return state;
  };
  const restoreState = async (state: SetupEditDiskState) => {
    for (const [path, file] of Object.entries(state)) {
      if (file.bytes === null) {
        await fs.rm(path, { force: true });
        continue;
      }
      await fs.writeFile(path, Buffer.from(file.bytes, "base64"));
      await fs.chmod(path, file.mode);
    }
  };
  const capture = async () => {
    const before = await readState();
    const boundaries: { destination: string; state: SetupEditDiskState }[] = [];
    const rename = fs.rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      const destination = String(to);
      if ([...paths, journalPath].includes(destination))
        boundaries.push({ destination, state: await readState() });
    });
    try {
      await service().save(next);
    } finally {
      spy.mockRestore();
    }
    return { before, boundaries, after: await readState() };
  };
  return {
    workspace,
    rootDir,
    configPath,
    paths,
    journalPath,
    service,
    initial,
    next,
    input,
    activate,
    readState,
    restoreState,
    capture,
  };
}
export type SetupEditFixture = Awaited<
  ReturnType<typeof createSetupEditFixture>
>;
