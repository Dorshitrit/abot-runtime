import { statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileOutputPresentation } from "../adapters/registered-tool-normal-invocations/execution/file-output-presentation.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { captureFileOutputRootId } from "../capabilities/file-output-root-identity.js";

let folder: string;
let agentWorkDir: string;
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts");
  await mkdir(artifacts, { recursive: true });
  folder = await mkdtemp(join(artifacts, "root-binding-tests-"));
  agentWorkDir = join(folder, "configured");
  await mkdir(agentWorkDir);
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function rootIdentity(path: string) {
  const identity = statSync(path, { bigint: true });
  return {
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birthtimeNs: identity.birthtimeNs.toString(),
  };
}

function fixture() {
  const paths = { agentWorkDir };
  const target = createRuntimeToolPathResolver(paths).resolve("result.txt");
  return {
    collector: createFileOutputPresentation(paths),
    report: {
      target,
      operation: "created" as const,
      rootIdentity: rootIdentity(agentWorkDir),
    },
  };
}

const successfulMutation = {
  tool: "write_file",
  ok: true,
  output: "saved",
  producedNewInformation: true,
  data: { mutationEvidence: true },
};

describe("file output binding to the root that committed the mutation", () => {
  it.each([
    undefined,
    null,
    {},
    { device: "0", inode: "0", birthtimeNs: "1" },
    { device: "0", inode: "1", birthtimeNs: "0" },
    { device: "-1", inode: "1", birthtimeNs: "1" },
    { device: "0", inode: "01", birthtimeNs: "1" },
  ])(
    "omits a missing or malformed committed root identity %#",
    async (identity) => {
      const { collector, report } = fixture();
      const input = { ...report, rootIdentity: identity };
      collector.report(input as typeof report);
      expect(
        collector.finish(successfulMutation, undefined, "mutating"),
      ).toBeUndefined();
      expect(await readdir(agentWorkDir)).toEqual([]);
    },
  );

  it("keeps the committed root's identity outside event and tool result data", () => {
    const { collector, report } = fixture();
    collector.report(report);
    const metadata = collector.finish(
      successfulMutation,
      undefined,
      "mutating",
    );
    expect(metadata).toHaveProperty("fileOutput.rootId");
    expect(JSON.stringify(metadata)).not.toContain("rootIdentity");
    expect(JSON.stringify(successfulMutation)).not.toContain("rootIdentity");
  });

  it("rejects root A to B to A when the write committed under B", async () => {
    const { collector, report } = fixture();
    await rename(agentWorkDir, join(folder, "original"));
    await mkdir(agentWorkDir);
    await writeFile(join(agentWorkDir, "result.txt"), "committed under B");
    const committedIdentity = rootIdentity(agentWorkDir);
    await rename(agentWorkDir, join(folder, "committed"));
    await rename(join(folder, "original"), agentWorkDir);
    collector.report({ ...report, rootIdentity: committedIdentity });
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
    expect(await readdir(agentWorkDir)).toEqual([]);
    expect(await readdir(join(folder, "committed"))).toEqual(["result.txt"]);
  });

  it("checks the expected root before any marker read or creation", async () => {
    const other = join(folder, "other");
    await mkdir(other);
    const expected = rootIdentity(other);
    expect(() =>
      captureFileOutputRootId("agent_work", agentWorkDir, expected),
    ).toThrow();
    expect(await readdir(agentWorkDir)).toEqual([]);
  });
});
