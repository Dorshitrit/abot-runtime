import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Exercises the real packaged CLI without connecting to or starting a model server. */
export async function verifyPackedLlamaCppSetup(cliPath: string, temporaryRoot: string): Promise<void> {
  const rootDir = join(temporaryRoot, "llamacpp-cli-consumer");
  await mkdir(rootDir);
  const run = (args: string[]) => execFileSync(process.execPath, [cliPath, ...args], {
    cwd: rootDir, encoding: "utf8", stdio: "pipe",
  });
  run(["init", "--provider", "llamacpp", "--model", "fixture-model",
    "--base-url", "http://127.0.0.1:8080", "--supports-thinking", "true", "--reasoning-budget", "512"]);
  run(["add-model", "--provider", "llamacpp", "--model", "fixture-model",
    "--profile", "llama-server-default", "--supports-thinking", "true", "--reasoning-budget", "server-default"]);
  const read = async (file: string) => JSON.parse(await readFile(join(rootDir, file), "utf8"));
  const runtime = await read("local/runtime.config.json");
  const model = await read("local/models/default.config.json");
  const added = await read("local/models/llama-server-default.config.json");
  const runner = await read("local/request-runner.config.json");
  if (runtime.models.providers.llamacpp?.baseUrl !== "http://127.0.0.1:8080")
    throw new Error("packed llama.cpp setup lost its server origin");
  if (model.supportsThinking !== true || model.generation?.reasoningBudget?.tokens !== 512)
    throw new Error("packed llama.cpp setup lost its thinking capability or budget");
  if (added.generation?.reasoningBudget?.mode !== "server-default" || runner.models.defaults.profileId !== "default")
    throw new Error("packed llama.cpp addition changed its budget or existing default");
}
