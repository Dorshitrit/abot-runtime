import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

/** Copy one real CLI initialization into independent, mutable consumer roots. */
export function createInitRuntimeValidationFixture(artifactRoot: string) {
  const consumers: string[] = [];
  let seedRoot: string | undefined;

  async function createRoot(prefix: string): Promise<string> {
    await mkdir(artifactRoot, { recursive: true });
    return mkdtemp(join(artifactRoot, prefix));
  }

  async function createConsumer(): Promise<string> {
    const root = await createRoot("consumer with spaces ");
    consumers.push(root);
    return root;
  }

  async function initializeSeed(initialize: (root: string) => void): Promise<void> {
    seedRoot = await createRoot("seed with spaces ");
    initialize(seedRoot);
  }

  async function createInitializedConsumer(): Promise<string> {
    if (!seedRoot) throw new Error("The real CLI seed must be initialized before copying it.");
    const root = await createConsumer();
    // Include the CLI-created runtime directories, not just the starter files.
    await cp(seedRoot, root, { recursive: true });
    return root;
  }

  async function cleanupConsumers(): Promise<void> {
    await Promise.all(consumers.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }

  async function cleanupSeed(): Promise<void> {
    if (!seedRoot) return;
    await rm(seedRoot, { recursive: true, force: true });
    seedRoot = undefined;
  }

  return { createConsumer, initializeSeed, createInitializedConsumer, cleanupConsumers, cleanupSeed };
}
