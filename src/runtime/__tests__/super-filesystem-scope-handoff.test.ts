import { workerFusedReply } from "./support/worker-evidence-script.js";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RUNTIME_FILESYSTEM_SCOPE_KIND } from "../context/runtime-filesystem-scope.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  assertFilesystemScope,
  capsules,
  decision,
  filesystemScopeFixture,
  type FilesystemScriptCall,
} from "./support/filesystem-scope-integration-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("SUPER carries one captured filesystem root through cwd, Planner, Worker, payload, review and the physical artifact", async () => {
  const fixture = await filesystemScopeFixture("supervisor-worker-v1");
  const root = fixture.config.paths.agentWorkDir;
  const body =
    "<!doctype html><title>LUNA</title><main>Exact requested artifact</main>\n";
  await mkdir(join(root, "LUNA"));
  const calls: readonly FilesystemScriptCall[] = [
    {
      step: "supervisor.decision",
      format: "supervisor_fused_routing",
      output: decision({
        action: "invoke_role",
        roleId: "planner",
        workingDirectory: join(root, "LUNA"),
        objective: "Create the exact LUNA artifact.",
        acknowledgement: "I will create the requested file.",
      }),
    },
    {
      step: "planner.decision",
      output: decision({
        action: "invoke_role",
        roleId: "worker",
        plan: {
          summary: "Create LUNA.",
          items: [{ title: "Write", objective: "Write the exact LUNA file." }],
        },
        selectedItemIndexes: [0],
        workerCapabilityScope: { catalogGroupIds: ["write"] },
      }),
    },
    {
      step: "worker.decision",
      output: (input) => workerFusedReply(input, {
        action: "invoke_capability",
        capabilityId: "write_complete_file",
        intent: "Write the exact file.",
        authoringObjective: `Write exactly ${JSON.stringify(body)}.`,
        selectionControls: { path: "index.html" },
      }).text,
    },
    { step: "tool_payload.raw", output: body },
    { step: "worker.decision", output: (input) => workerFusedReply(input, { action: "return_result" }).text },
    {
      step: "planner.decision",
      output: (input) => {
        const child = capsules(input, "runtime_child_result").at(-1)!;
        expect(child).toMatchObject({
          roleId: "worker",
          outcome: "completed",
        });
        expect(JSON.parse(child.summary as string)).toMatchObject({ kind: "runtime_worker_execution_report_v1",
          executionOutcomes: [{ capabilityId: "write_complete_file", outcome: "succeeded", observedEffect: "mutation" }] });
        return decision({
          action: "return_result",
          result: "The requested artifact was created.",
        });
      },
    },
    {
      step: "supervisor.decision",
      format: "supervisor_decision",
      output: (input) => {
        expect(capsules(input, "runtime_child_result").at(-1)).toMatchObject({
          roleId: "planner",
          outcome: "completed",
        });
        return decision({ action: "invoke_role", roleId: "reviewer" });
      },
    },
    {
      step: "reviewer.decision",
      output: (input) => {
        const audit = capsules(input, "runtime_reviewer_audit_v4")[0]!;
        const effects = audit.effects as {
          evidenceRef: string;
          outcome: string;
        }[];
        expect(effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "succeeded" }),
          ]),
        );
        return decision({
          action: "report_gaps",
          reviewScopeId: (audit.auditScope as { reviewScopeId: string })
            .reviewScopeId,
          summary:
            "The write succeeded; independent runtime readback was not requested.",
          audit: {
            evidenceAssessments: effects.map(({ evidenceRef }) => ({
              evidenceRef,
              status: "supports",
              finding: "Successful write receipt.",
            })),
            completionAssessment: {
              status: "gap",
              evidenceRefs: effects.map(({ evidenceRef }) => evidenceRef),
              finding: "No independent readback in supplied evidence.",
            },
          },
          gaps: [
            {
              kind: "missing_evidence",
              subjectRefs: [],
              factRefs: [],
              evidenceRefs: [],
              summary: "No independent readback.",
            },
          ],
        });
      },
    },
    {
      step: "supervisor.decision",
      format: "supervisor_decision",
      output: (input) => {
        expect(capsules(input, "runtime_child_result").at(-1)).toMatchObject({
          roleId: "reviewer",
          outcome: "completed",
        });
        return decision({ action: "respond" });
      },
    },
    {
      step: "supervisor.response",
      output:
        "Created LUNA/index.html; independent readback remains outside the review evidence.",
    },
  ];
  const scripted = fixture.script(calls, (input) => {
    if (
      typeof input.format === "object" &&
      input.format?.name === "supervisor_fused_routing"
    ) {
      assertFilesystemScope(input, root, null, true, {});
    } else if (
      ["worker.decision", "capability.controls", "tool_payload.raw"].includes(
        input.modelStep!,
      )
    ) {
      assertFilesystemScope(input, root, "LUNA", false, {
        write_complete_file: ["path"],
      });
    } else {
      expect(capsules(input, RUNTIME_FILESYSTEM_SCOPE_KIND)).toEqual([]);
    }
    if (input.modelStep === "worker.decision") {
      expect(capsules(input, "runtime_worker_assignment")).toEqual([
        expect.objectContaining({
          workingDirectory: "LUNA",
          parentCallId: "call-2",
        }),
      ]);
    }
  });
  try {
    await fixture.run(scripted.model);
    scripted.assertComplete();
    expect(fixture.events.filter((event) => event.type === "failed")).toEqual(
      [],
    );
    expect(
      fixture.events.filter((event) => event.type === "completed"),
    ).toHaveLength(1);
    expect(await readFile(join(root, "LUNA", "index.html"), "utf8")).toBe(body);
    await expect(readFile(join(root, "index.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      fixture.events.filter((event) => event.name === "tool.completed"),
    ).toEqual([expect.objectContaining({ tool: "write_file", ok: true })]);
  } finally {
    await fixture.close();
  }
}, 15_000);
