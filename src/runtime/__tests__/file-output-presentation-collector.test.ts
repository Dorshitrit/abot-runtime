import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ToolFileOutputReport,
  ToolFileOutputReceipt,
} from "../../capabilities/file-output-presentation.js";
import {
  createFileOutputRootId,
  parseToolFileOutputReceipt,
} from "../../capabilities/file-output-presentation.js";
import { createFileOutputPresentation } from "../adapters/registered-tool-normal-invocations/execution/file-output-presentation.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { readFileOutputRootId } from "../capabilities/file-output-root-identity.js";

const successfulMutation = {
  tool: "write_file",
  ok: true,
  output: "saved",
  producedNewInformation: true,
  data: { mutationEvidence: true },
};

function rootIdentity(path: string) {
  const identity = statSync(path, { bigint: true });
  return {
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birthtimeNs: identity.birthtimeNs.toString(),
  };
}

describe("file output origin collector", () => {
  let root = "";
  let agentWorkDir = "";
  let workspaceDir = "";

  beforeEach(async () => {
    const artifacts = path.join(process.cwd(), ".codex", "artifacts");
    await mkdir(artifacts, { recursive: true });
    root = await mkdtemp(path.join(artifacts, "file-output-collector-test-"));
    agentWorkDir = path.join(root, "agent");
    workspaceDir = path.join(root, "workspace");
    await Promise.all([mkdir(agentWorkDir), mkdir(workspaceDir)]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const roots = { rootDir: root, agentWorkDir, workspaceDir };
    const resolver = createRuntimeToolPathResolver(roots);
    return {
      roots,
      collector: createFileOutputPresentation(roots),
      report: {
        target: resolver.resolve("report.txt"),
        operation: "created" as const,
        rootIdentity: rootIdentity(agentWorkDir),
      },
    };
  }

  test("accepts identical reports once and freezes the detached receipt", () => {
    const { collector, report } = fixture();
    collector.report(report);
    collector.report(report);
    const result = collector.finish(
      successfulMutation,
      { byteCount: 5 },
      "mutating",
    );
    expect(result).toMatchObject({
      byteCount: 5,
      fileOutput: {
        rootId: readFileOutputRootId("agent_work", report.target.rootPath),
        relativePath: "report.txt",
      },
    });
    expect(Object.isFrozen(result?.fileOutput)).toBe(true);
    expect(JSON.stringify(successfulMutation)).not.toContain("fileOutput");
  });

  test("rejects conflicting output reports instead of choosing one", () => {
    const { collector, report } = fixture();
    collector.report(report);
    collector.report({ ...report, operation: "updated" });
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
  });

  test("rejects malformed reports without throwing into tool execution", () => {
    const { collector, report } = fixture();
    collector.report(report);
    expect(() =>
      collector.report(null as unknown as ToolFileOutputReport),
    ).not.toThrow();
    expect(
      collector.finish(successfulMutation, { path: "report.txt" }, "mutating"),
    ).toEqual({ path: "report.txt" });
  });

  test("rejects a report whose original root differs from the request root", () => {
    const { collector, report } = fixture();
    collector.report({
      ...report,
      target: { ...report.target, rootPath: workspaceDir },
    });
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
  });

  test("rejects a report whose relative target was replaced", () => {
    const { collector, report } = fixture();
    collector.report({
      ...report,
      target: { ...report.target, relativePath: "other.txt" },
    });
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
  });

  test("rejects a symlink escape even with a plausible display target", async () => {
    const { collector, report } = fixture();
    await symlink(workspaceDir, path.join(agentWorkDir, "escape"));
    collector.report({
      ...report,
      target: {
        ...report.target,
        absolutePath: path.join(agentWorkDir, "escape", "report.txt"),
        relativePath: "escape/report.txt",
        logicalPath: "escape/report.txt",
      },
    });
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
  });

  test("keeps nested configured roots distinct", async () => {
    const nested = path.join(agentWorkDir, "nested");
    await mkdir(nested);
    const roots = { agentWorkDir, workspaceDir: nested };
    const resolver = createRuntimeToolPathResolver(roots);
    const agent = createFileOutputPresentation(roots);
    const workspace = createFileOutputPresentation(roots);
    agent.report({
      target: resolver.resolve("nested/report.txt"),
      operation: "created",
      rootIdentity: rootIdentity(agentWorkDir),
    });
    workspace.report({
      target: resolver.resolve("workspace/report.txt"),
      operation: "created",
      rootIdentity: rootIdentity(nested),
    });
    const agentReceipt = agent.finish(
      successfulMutation,
      undefined,
      "mutating",
    )?.fileOutput;
    const workspaceReceipt = workspace.finish(
      successfulMutation,
      undefined,
      "mutating",
    )?.fileOutput;
    expect(agentReceipt).toMatchObject({
      location: "agent_work",
      relativePath: "nested/report.txt",
    });
    expect(workspaceReceipt).toMatchObject({
      location: "workspace",
      relativePath: "report.txt",
    });
    expect(agentReceipt).not.toEqual(workspaceReceipt);
  });

  test.each([
    {
      label: "failed mutation",
      result: { ...successfulMutation, ok: false },
      effect: "mutating" as const,
    },
    {
      label: "no-op mutation",
      result: { ...successfulMutation, data: { mutationEvidence: false } },
      effect: "mutating" as const,
    },
    {
      label: "read-only operation",
      result: successfulMutation,
      effect: "read_only" as const,
    },
  ])("omits presentation for $label", ({ result, effect }) => {
    const { collector, report } = fixture();
    collector.report(report);
    expect(collector.finish(result, undefined, effect)).toBeUndefined();
  });

  test("strips a plugin-supplied receipt unless the host observed its source", () => {
    const { collector } = fixture();
    expect(
      collector.finish(
        successfulMutation,
        {
          fileOutput: { location: "host_system", relativePath: "secret" },
          byteCount: 5,
        },
        "mutating",
      ),
    ).toEqual({ byteCount: 5 });
  });

  test("ignores reports delivered after execution completed", () => {
    const { collector, report } = fixture();
    collector.finish(successfulMutation, undefined, "mutating");
    collector.report(report);
    expect(
      collector.finish(successfulMutation, undefined, "mutating"),
    ).toBeUndefined();
  });
});

describe("file output receipt wire contract", () => {
  const marker = "a".repeat(64);
  const identity = {
    dev: 1n,
    ino: 2n,
    birthtimeNs: 3n,
    isDirectory: () => true,
  };
  const receipt: ToolFileOutputReceipt = {
    version: 1,
    location: "agent_work",
    rootId: createFileOutputRootId(
      "agent_work",
      "/root/agent",
      identity,
      marker,
    ),
    relativePath: "folder/report.txt",
    logicalPath: "folder/report.txt",
    operation: "created",
  };

  test("root identity depends on location and canonical root", () => {
    expect(
      createFileOutputRootId("agent_work", "/root/agent", identity, marker),
    ).not.toEqual(
      createFileOutputRootId("workspace", "/root/agent", identity, marker),
    );
    expect(
      createFileOutputRootId("agent_work", "/root/agent", identity, marker),
    ).not.toEqual(
      createFileOutputRootId("agent_work", "/other/agent", identity, marker),
    );
  });

  test.each([{ dev: 4n }, { ino: 5n }, { birthtimeNs: 6n }])(
    "root identity changes with directory-instance field %#",
    (change) => {
      expect(
        createFileOutputRootId(
          "agent_work",
          "/root/agent",
          {
            ...identity,
            ...change,
          },
          marker,
        ),
      ).not.toEqual(receipt.rootId);
    },
  );

  test("distinguishes new root tokens when inode and birth time are reused", () => {
    expect(
      createFileOutputRootId(
        "agent_work",
        "/root/agent",
        identity,
        "b".repeat(64),
      ),
    ).not.toEqual(receipt.rootId);
  });

  test.each([
    { birthtimeNs: 0n },
    { birthtimeNs: undefined },
    { ino: 0n },
    { isDirectory: () => false },
  ])("rejects unavailable directory creation identity %#", (change) => {
    expect(() =>
      createFileOutputRootId(
        "agent_work",
        "/root/agent",
        {
          ...identity,
          ...change,
        } as typeof identity,
        marker,
      ),
    ).toThrow("root identity is unavailable");
  });

  test("returns a detached receipt without extraneous physical paths", () => {
    const parsed = parseToolFileOutputReceipt({
      ...receipt,
      absolutePath: "/secret",
    });
    expect(parsed).toEqual(receipt);
    expect(parsed).not.toBe(receipt);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test.each([
    "../secret",
    "/secret",
    "a/../secret",
    "a/./b",
    "a//b",
    "C:/secret",
    "a\\b",
    "",
    "a\0b",
  ])("rejects noncanonical relative path %j", (relativePath) => {
    expect(
      parseToolFileOutputReceipt({
        ...receipt,
        relativePath,
        logicalPath: relativePath,
      }),
    ).toBeUndefined();
  });

  test.each([
    { version: 2 },
    { location: "runtime_root" },
    { operation: "deleted" },
    { rootId: "/root/agent" },
    { logicalPath: "another.txt" },
  ])("rejects incompatible or invalid receipt %j", (changes) => {
    expect(
      parseToolFileOutputReceipt({ ...receipt, ...changes }),
    ).toBeUndefined();
  });
});
