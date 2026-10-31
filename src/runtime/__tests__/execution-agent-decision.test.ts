import { describe, expect, test } from "vitest";

import {
  CAPABILITY_CATALOG_GROUP_COUNT_MAX,
  type CapabilityDescriptor,
} from "../orchestration/capability-adapters/index.js";
import {
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";

const observeFile = {
  capabilityId: "observe_file",
  summary: "Observe one file.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["path"],
  },
  selectionControlIds: ["path"],
} as const satisfies CapabilityDescriptor;

const observeProject = {
  capabilityId: "observe_project",
  summary: "Observe the current project.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
} as const satisfies CapabilityDescriptor;

const writeFile = {
  capabilityId: "write_file",
  summary: "Write one file.",
  effect: "mutation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      content: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["path", "content"],
  },
  selectionControlIds: ["path"],
} as const satisfies CapabilityDescriptor;

describe("Single Execution Agent structured decision", () => {
  test("builds one strict dynamic envelope and gates optional services", () => {
    const format = createExecutionAgentDecisionFormat({
      capabilities: [observeFile, observeProject, writeFile],
      capabilityCatalogGroupIds: ["read", "write"],
      maxBatchCapabilityExecutions: 3,
      includeAcknowledgement: true,
      includeTitle: true,
      allowPlanner: true,
      allowAuditor: true,
      availableAuditCriterionIds: ["plan-criterion-1"],
    });

    expect(format).toMatchObject({
      type: "json_schema",
      name: "execution_agent_decision",
      strict: true,
      schema: {
        type: "object",
        required: ["decision"],
        additionalProperties: false,
      },
    });
    const variants = decisionVariants(format.schema);
    expect(variants.flatMap(readActionEnums)).toEqual(
      expect.arrayContaining([
        "respond",
        "open_capability_scope",
        "blocked",
        "invoke_capability",
        "invoke_capabilities",
        "invoke_planner",
        "invoke_auditor",
      ]),
    );
    expect(variants.slice(0, 2).flatMap(readActionEnums)).toEqual([
      "open_capability_scope",
      "respond",
    ]);
    expect(variants.flatMap(readActionEnums)).not.toContain(
      "extend_capability_scope",
    );
    expect(variants.flatMap(readActionEnums)).not.toContain(
      "complete_plan_node",
    );
    expect(variants.flatMap(readActionEnums)).not.toContain(
      "complete_plan_nodes",
    );
    variants.forEach((variant) => {
      expect(variant.required).toContain("acknowledgement");
      expect(variant.required).toContain("title");
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toEqual(Object.keys(variant.properties));
    });
    const respondVariant = variants.find((variant) =>
      readActionEnums(variant).includes("respond"),
    );
    const blockedVariant = variants.find((variant) =>
      readActionEnums(variant).includes("blocked"),
    );
    expect(respondVariant?.properties).not.toHaveProperty("response");
    expect(blockedVariant?.properties).toHaveProperty("response");
    expect(JSON.stringify(format.schema)).toContain("selectionControls");
    expect(JSON.stringify(format.schema)).not.toContain("uniqueItems");
    expect(format.postValidatedSchemaConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "maxLength",
          path: expect.stringContaining("/properties/response/maxLength"),
        }),
        expect.objectContaining({
          keyword: "maxLength",
          path: expect.stringContaining(
            "/properties/selectionControls/properties/path/maxLength",
          ),
        }),
      ]),
    );

    const defaultActions = decisionVariants(
      createExecutionAgentDecisionFormat().schema,
    ).flatMap(readActionEnums);
    expect(defaultActions).toEqual(["respond", "blocked"]);

    const parameterlessObservationActions = decisionVariants(
      createExecutionAgentDecisionFormat({
        capabilities: [observeProject],
        maxBatchCapabilityExecutions: 2,
      }).schema,
    ).flatMap(readActionEnums);
    expect(parameterlessObservationActions).toContain("invoke_capability");
    expect(parameterlessObservationActions).toContain("invoke_capabilities");

    const activeScopeActions = decisionVariants(
      createExecutionAgentDecisionFormat({
        capabilities: [observeFile, observeProject],
        capabilityCatalogGroupIds: ["read", "write"],
        activeCapabilityCatalogGroupIds: ["read"],
        maxBatchCapabilityExecutions: 2,
      }).schema,
    ).flatMap(readActionEnums);
    expect(activeScopeActions).not.toContain("open_capability_scope");
    expect(activeScopeActions).toContain("extend_capability_scope");
    expect(
      activeScopeActions.indexOf("extend_capability_scope"),
    ).toBeGreaterThan(activeScopeActions.lastIndexOf("invoke_capabilities"));

    const fullyActiveScopeActions = decisionVariants(
      createExecutionAgentDecisionFormat({
        capabilities: [observeFile, observeProject],
        capabilityCatalogGroupIds: ["read", "write"],
        activeCapabilityCatalogGroupIds: ["read", "write"],
        maxBatchCapabilityExecutions: 2,
      }).schema,
    ).flatMap(readActionEnums);
    expect(fullyActiveScopeActions).not.toContain("extend_capability_scope");
  });

  test("accepts only a nonempty unique selection of manifest-projected catalog groups", () => {
    const options = {
      capabilityCatalogGroupIds: ["read", "write"],
    } as const;
    const accepted = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "open_capability_scope",
          catalogGroupIds: ["read", "write"],
        },
      }),
      options,
    );
    expect(accepted).toEqual({
      ok: true,
      decision: {
        action: "open_capability_scope",
        catalogGroupIds: ["read", "write"],
      },
    });
    if (accepted.ok && accepted.decision.action === "open_capability_scope") {
      expect(Object.isFrozen(accepted.decision.catalogGroupIds)).toBe(true);
    }

    for (const catalogGroupIds of [[], ["read", "read"], ["unknown"]]) {
      expect(
        parseExecutionAgentDecisionOutput(
          JSON.stringify({
            decision: {
              action: "open_capability_scope",
              catalogGroupIds,
            },
          }),
          options,
        ),
      ).toMatchObject({ ok: false, stage: "domain_parser" });
    }

    expect(
      JSON.stringify(createExecutionAgentDecisionFormat(options).schema),
    ).not.toContain("uniqueItems");

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "extend_capability_scope",
            catalogGroupIds: ["write"],
          },
        }),
        options,
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_capability_scope_extend_unavailable",
        }),
      ]),
    });

    const activeOptions = {
      ...options,
      activeCapabilityCatalogGroupIds: ["read"],
    } as const;
    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "extend_capability_scope",
            catalogGroupIds: ["write"],
          },
        }),
        activeOptions,
      ),
    ).toEqual({
      ok: true,
      decision: {
        action: "extend_capability_scope",
        catalogGroupIds: ["write"],
      },
    });

    for (const catalogGroupIds of [["read"], ["write", "write"], ["unknown"]]) {
      expect(
        parseExecutionAgentDecisionOutput(
          JSON.stringify({
            decision: {
              action: "extend_capability_scope",
              catalogGroupIds,
            },
          }),
          activeOptions,
        ),
      ).toMatchObject({
        ok: false,
        stage: "domain_parser",
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(
              /^execution_agent_capability_scope_(invalid|group_unavailable)$/u,
            ),
          }),
        ]),
      });
    }

    const activeFormat = createExecutionAgentDecisionFormat(activeOptions);
    const extendVariant = decisionVariants(activeFormat.schema).find(
      (variant) => readActionEnums(variant).includes("extend_capability_scope"),
    );
    expect(extendVariant).toBeDefined();
    expect(extendVariant?.properties.catalogGroupIds).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: { type: "string", enum: ["write"] },
    });
    const activeSchema = JSON.stringify(activeFormat.schema);
    expect(activeSchema).not.toContain('"uniqueItems"');
    expect(activeSchema).not.toContain('"contains"');
    expect(activeSchema).not.toContain('"not"');

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "open_capability_scope",
            catalogGroupIds: ["read"],
          },
        }),
        activeOptions,
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_capability_scope_open_unavailable",
        }),
      ]),
    });

    const overLimitGroups = Array.from(
      { length: CAPABILITY_CATALOG_GROUP_COUNT_MAX + 1 },
      (_, index) => `group-${index}`,
    );
    expect(() =>
      createExecutionAgentDecisionFormat({
        capabilityCatalogGroupIds: overLimitGroups,
      }),
    ).toThrow("execution_agent_capability_catalog_groups_invalid");
  });

  test("accepts respond metadata but keeps its response body in the raw presentation step", () => {
    const parsed = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "respond",
          acknowledgement: "I will answer now.",
          title: "Direct answer",
        },
      }),
      { includeAcknowledgement: true, includeTitle: true },
    );

    expect(parsed).toEqual({
      ok: true,
      decision: {
        action: "respond",
        acknowledgement: "I will answer now.",
        title: "Direct answer",
      },
    });
    if (parsed.ok) expect(Object.isFrozen(parsed.decision)).toBe(true);

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "respond",
            response: "Not permitted here.",
            acknowledgement: "This metadata is permitted.",
            title: "Permitted metadata",
          },
        }),
        { includeAcknowledgement: true, includeTitle: true },
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_decision_shape_invalid",
        }),
      ]),
    });

    const blocked = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: { action: "blocked", response: "  Blocked.  " },
      }),
    );
    expect(blocked).toEqual({
      ok: true,
      decision: { action: "blocked", response: "Blocked." },
    });
  });

  test("omits and rejects respond while the canonical completion gate is closed", () => {
    const options = { allowRespond: false } as const;
    const actions = decisionVariants(
      createExecutionAgentDecisionFormat(options).schema,
    ).flatMap(readActionEnums);
    expect(actions).not.toContain("respond");
    expect(actions).toContain("blocked");

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: { action: "respond" },
        }),
        options,
      ),
    ).toMatchObject({
      ok: false,
      stage: "domain_parser",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_response_not_allowed",
        }),
      ]),
    });
  });

  test("validates dynamic selection controls and materializes full controls", () => {
    const complete = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capability",
          capabilityId: "observe_file",
          selectionControls: { path: "index.html" },
        },
      }),
      { capabilities: [observeFile, writeFile] },
    );
    expect(complete).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "observe_file",
        selectionControls: { path: "index.html" },
        controls: { path: "index.html" },
      },
    });
    if (complete.ok && complete.decision.action === "invoke_capability") {
      expect(Object.isFrozen(complete.decision.selectionControls)).toBe(true);
      expect(Object.isFrozen(complete.decision.controls)).toBe(true);
    }

    const refinementInvocation = {
      action: "invoke_capability",
      capabilityId: "write_file",
      operationObjective: "Write only the requested content to index.html.",
      controlsEvidenceExecutionIds: [],
      selectionControls: { path: "index.html" },
    } as const;
    const parsed = parseExecutionAgentDecisionOutput(
      JSON.stringify({ decision: refinementInvocation }),
      { capabilities: [observeFile, writeFile] },
    );
    expect(parsed).toEqual({ ok: true, decision: refinementInvocation });

    const invalid = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capability",
          capabilityId: "observe_file",
          selectionControls: { path: "index.html", unknown: true },
        },
      }),
      { capabilities: [observeFile] },
    );
    expect(invalid).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_capability_controls_unknown",
        }),
      ]),
    });
  });

  test("normalizes the first working directory", () => {
    const parsed = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capability",
          capabilityId: "observe_file",
          selectionControls: { path: "site/index.html" },
          workingDirectory: "./site/",
        },
      }),
      {
        capabilities: [observeFile],
        includeWorkingDirectory: true,
      },
    );
    expect(parsed).toEqual({
      ok: true,
      decision: {
        action: "invoke_capability",
        capabilityId: "observe_file",
        selectionControls: { path: "site/index.html" },
        controls: { path: "site/index.html" },
        workingDirectory: "site",
      },
    });

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capability",
            capabilityId: "observe_file",
            selectionControls: { path: "index.html" },
            workingDirectory: "../site",
          },
        }),
        {
          capabilities: [observeFile],
          includeWorkingDirectory: true,
        },
      ),
    ).toMatchObject({ ok: false, stage: "domain_parser" });

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_capability",
            capabilityId: "observe_file",
            selectionControls: { path: "index.html" },
            workingDirectory: null,
          },
        }),
        { capabilities: [observeFile], includeWorkingDirectory: true },
      ),
    ).toMatchObject({
      ok: true,
      decision: { workingDirectory: "." },
    });
  });

  test("accepts only independent observation capabilities in a batch", () => {
    const accepted = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_file",
              selectionControls: { path: "index.html" },
            },
            {
              capabilityId: "observe_project",
            },
          ],
        },
      }),
      {
        capabilities: [observeFile, observeProject, writeFile],
        maxBatchCapabilityExecutions: 3,
      },
    );
    expect(accepted).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "observe_file",
            selectionControls: { path: "index.html" },
            controls: { path: "index.html" },
          },
          {
            capabilityId: "observe_project",
            controls: {},
          },
        ],
      },
    });
    if (accepted.ok && accepted.decision.action === "invoke_capabilities") {
      expect(Object.isFrozen(accepted.decision.invocations)).toBe(true);
      expect(Object.isFrozen(accepted.decision.invocations[0]?.controls)).toBe(
        true,
      );
    }

    const mutation = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_project",
            },
            {
              capabilityId: "write_file",
              selectionControls: { path: "index.html" },
            },
          ],
        },
      }),
      {
        capabilities: [observeProject, writeFile],
        maxBatchCapabilityExecutions: 2,
      },
    );
    expect(mutation).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_capability_batch_effect_invalid",
        }),
      ]),
    });
  });

  test("defers exact duplicate detection until repeated batch invocations are fully materialized", () => {
    const accepted = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_file",
              selectionControls: { path: "index.html" },
            },
            {
              capabilityId: "observe_file",
              selectionControls: { path: "styles.css" },
            },
          ],
        },
      }),
      { capabilities: [observeFile], maxBatchCapabilityExecutions: 2 },
    );
    expect(accepted).toMatchObject({ ok: true });

    const ambiguous = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_project",
            },
            {
              capabilityId: "observe_project",
            },
          ],
        },
      }),
      { capabilities: [observeProject], maxBatchCapabilityExecutions: 2 },
    );
    expect(ambiguous).toMatchObject({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          { capabilityId: "observe_project", controls: {} },
          { capabilityId: "observe_project", controls: {} },
        ],
      },
    });

    const duplicate = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_file",
              selectionControls: { path: "index.html" },
            },
            {
              capabilityId: "observe_file",
              selectionControls: { path: "index.html" },
            },
          ],
        },
      }),
      { capabilities: [observeFile], maxBatchCapabilityExecutions: 2 },
    );
    expect(duplicate).toMatchObject({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: "observe_file",
            selectionControls: { path: "index.html" },
            controls: { path: "index.html" },
          },
          {
            capabilityId: "observe_file",
            selectionControls: { path: "index.html" },
            controls: { path: "index.html" },
          },
        ],
      },
    });

    const malformed = parseExecutionAgentDecisionOutput(
      JSON.stringify({
        decision: {
          action: "invoke_capabilities",
          invocations: [
            {
              capabilityId: "observe_file",
              selectionControls: { path: "index.html" },
            },
            {
              capabilityId: "observe_file",
              selectionControls: {},
            },
          ],
        },
      }),
      { capabilities: [observeFile], maxBatchCapabilityExecutions: 2 },
    );
    expect(malformed).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "execution_agent_capability_controls_required_missing",
          path: "decision.invocations.1.selectionControls.path",
        }),
      ],
    });
    if (malformed.ok) throw new Error("expected malformed batch rejection");
    expect(
      malformed.issues.some(({ code }) => code.includes("batch_binding")),
    ).toBe(false);
  });

  test("gates Planner and Auditor and freezes accepted audit arrays", () => {
    const plannerPayload = JSON.stringify({
      decision: {
        action: "invoke_planner",
        objective: "Create two dependent requested outcomes.",
      },
    });
    expect(parseExecutionAgentDecisionOutput(plannerPayload)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_planner_not_allowed",
        }),
      ]),
    });
    expect(
      parseExecutionAgentDecisionOutput(plannerPayload, {
        allowPlanner: true,
      }),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_planner",
        objective: "Create two dependent requested outcomes.",
      },
    });

    const auditPayload = JSON.stringify({
      decision: {
        action: "invoke_auditor",
        criterionIds: ["  plan-criterion-1  "],
      },
    });
    const audit = parseExecutionAgentDecisionOutput(auditPayload, {
      allowAuditor: true,
      availableAuditCriterionIds: ["plan-criterion-1"],
    });
    expect(audit).toEqual({
      ok: true,
      decision: {
        action: "invoke_auditor",
        criterionIds: ["plan-criterion-1"],
      },
    });
    if (audit.ok && audit.decision.action === "invoke_auditor") {
      expect(Object.isFrozen(audit.decision)).toBe(true);
      expect(Object.isFrozen(audit.decision.criterionIds)).toBe(true);
    }
  });

  test("rejects non-canonical envelopes and duplicate audit bindings", () => {
    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: { action: "respond" },
          explanation: "extra",
        }),
      ),
    ).toMatchObject({ ok: false, stage: "json_envelope" });

    expect(
      parseExecutionAgentDecisionOutput(
        JSON.stringify({
          decision: {
            action: "invoke_auditor",
            criterionIds: ["criterion-1", "criterion-1"],
          },
        }),
        {
          allowAuditor: true,
          availableAuditCriterionIds: ["criterion-1"],
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_audit_criteria_invalid",
        }),
      ]),
    });
  });
});

function decisionVariants(schema: unknown): Array<{
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: unknown;
}> {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error("missing decision schema");
  }
  const decision = schema.properties.decision;
  if (!isRecord(decision)) throw new Error("missing decision variants");
  const variants = Array.isArray(decision.anyOf) ? decision.anyOf : [decision];
  return variants.map((variant) => {
    if (
      !isRecord(variant) ||
      !isRecord(variant.properties) ||
      !Array.isArray(variant.required)
    ) {
      throw new Error("invalid decision variant");
    }
    return {
      properties: variant.properties,
      required: variant.required as string[],
      additionalProperties: variant.additionalProperties,
    };
  });
}

function readActionEnums(variant: {
  properties: Record<string, unknown>;
}): string[] {
  const action = variant.properties.action;
  return isRecord(action) && Array.isArray(action.enum)
    ? (action.enum as string[])
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
