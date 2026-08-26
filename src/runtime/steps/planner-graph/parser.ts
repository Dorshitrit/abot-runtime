import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  PLANNER_GRAPH_IDENTIFIER_MAX_LENGTH,
  PLANNER_GRAPH_TEXT_MAX_LENGTH,
  PLANNER_GRAPH_VALIDATION_ISSUE_COUNT_MAX,
  sealPlannerGraphLimits,
  type PlannerAcceptanceCriterionProposal,
  type PlannerGraphLimits,
  type PlannerGraphNodeProposal,
  type PlannerGraphOutcome,
  type PlannerGraphParseResult,
  type PlannerGraphValidationIssue,
} from "./contracts.js";

export function parsePlannerGraphOutput(
  text: string,
  inputLimits: PlannerGraphLimits,
): PlannerGraphParseResult {
  const limits = sealPlannerGraphLimits(inputLimits);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejected("json_envelope", [
      issue(
        "planner_graph_output_not_json",
        "decision",
        "Expected one JSON object.",
      ),
    ]);
  }
  const envelope = readStructuredDecisionEnvelope(decoded);
  if (!envelope) {
    return rejected("json_envelope", [
      issue(
        "planner_graph_envelope_invalid",
        "decision",
        "Expected one graph proposal inside the canonical decision envelope.",
      ),
    ]);
  }
  if (Object.hasOwn(envelope, "action")) return parseDecline(envelope);

  const issues: PlannerGraphValidationIssue[] = [];
  exactKeys(envelope, ["summary", "nodes"], "decision", issues);
  const summary = boundedText(envelope.summary);
  if (!summary) {
    issues.push(
      issue(
        "planner_graph_summary_invalid",
        "decision.summary",
        "summary must be bounded non-empty text.",
      ),
    );
  }
  const nodes = parseNodes(envelope.nodes, limits, issues);
  if (nodes) validateTopology(nodes, issues);
  if (issues.length > 0 || !summary || !nodes) {
    return rejected("domain_parser", issues);
  }
  const decision = deepFreeze({
    outcome: "proposal" as const,
    proposal: { summary, nodes },
  }) satisfies PlannerGraphOutcome;
  return Object.freeze({ ok: true as const, decision });
}

function parseDecline(
  envelope: Record<string, unknown>,
): PlannerGraphParseResult {
  const issues: PlannerGraphValidationIssue[] = [];
  exactKeys(envelope, ["action", "reason"], "decision", issues);
  if (envelope.action !== "decline") {
    issues.push(
      issue(
        "planner_graph_decline_action_invalid",
        "decision.action",
        'action must be exactly "decline".',
      ),
    );
  }
  const reason = boundedText(envelope.reason);
  if (!reason) {
    issues.push(
      issue(
        "planner_graph_decline_reason_invalid",
        "decision.reason",
        "reason must be bounded non-empty text.",
      ),
    );
  }
  if (issues.length > 0 || !reason || envelope.action !== "decline") {
    return rejected("domain_parser", issues);
  }
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze({ outcome: "decline" as const, reason }),
  });
}

function parseNodes(
  value: unknown,
  limits: PlannerGraphLimits,
  issues: PlannerGraphValidationIssue[],
): readonly PlannerGraphNodeProposal[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > limits.maxPlanNodes
  ) {
    issues.push(
      issue(
        "planner_graph_nodes_invalid",
        "decision.nodes",
        `nodes must contain between 2 and ${limits.maxPlanNodes} entries.`,
      ),
    );
    return undefined;
  }
  const nodes = value.flatMap((entry, index) => {
    const path = `decision.nodes.${index}`;
    if (!isRecord(entry)) {
      issues.push(
        issue("planner_graph_node_invalid", path, "Expected one node object."),
      );
      return [];
    }
    exactKeys(
      entry,
      ["localId", "title", "objective", "dependsOn", "acceptanceCriteria"],
      path,
      issues,
    );
    const localId = identifier(entry.localId);
    const title = boundedText(entry.title);
    const objective = boundedText(entry.objective);
    const dependsOn = identifierArray(entry.dependsOn);
    const acceptanceCriteria = parseCriteria(
      entry.acceptanceCriteria,
      path,
      limits,
      issues,
    );
    if (!localId)
      issues.push(
        issue(
          "planner_graph_node_id_invalid",
          `${path}.localId`,
          "localId is invalid.",
        ),
      );
    if (!title)
      issues.push(
        issue(
          "planner_graph_node_title_invalid",
          `${path}.title`,
          "title is invalid.",
        ),
      );
    if (!objective)
      issues.push(
        issue(
          "planner_graph_node_objective_invalid",
          `${path}.objective`,
          "objective is invalid.",
        ),
      );
    if (!dependsOn)
      issues.push(
        issue(
          "planner_graph_dependencies_invalid",
          `${path}.dependsOn`,
          "dependsOn must contain unique local ids.",
        ),
      );
    return localId && title && objective && dependsOn && acceptanceCriteria
      ? [
          Object.freeze({
            localId,
            title,
            objective,
            dependsOn,
            acceptanceCriteria,
          }),
        ]
      : [];
  });
  if (new Set(nodes.map(({ localId }) => localId)).size !== nodes.length) {
    issues.push(
      issue(
        "planner_graph_node_ids_duplicate",
        "decision.nodes",
        "Node local ids must be unique.",
      ),
    );
  }
  return nodes.length === value.length ? Object.freeze(nodes) : undefined;
}

function parseCriteria(
  value: unknown,
  nodePath: string,
  limits: PlannerGraphLimits,
  issues: PlannerGraphValidationIssue[],
): readonly PlannerAcceptanceCriterionProposal[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > limits.maxCriteriaPerNode
  ) {
    issues.push(
      issue(
        "planner_graph_criteria_invalid",
        `${nodePath}.acceptanceCriteria`,
        "Acceptance criteria are required and bounded.",
      ),
    );
    return undefined;
  }
  const criteria = value.flatMap((entry, index) => {
    const path = `${nodePath}.acceptanceCriteria.${index}`;
    if (!isRecord(entry)) {
      issues.push(
        issue(
          "planner_graph_criterion_invalid",
          path,
          "Expected one criterion object.",
        ),
      );
      return [];
    }
    exactKeys(entry, ["localId", "description", "verification"], path, issues);
    const localId = identifier(entry.localId);
    const description = boundedText(entry.description);
    const verification = entry.verification;
    if (
      !localId ||
      !description ||
      (verification !== "mechanical" && verification !== "semantic")
    ) {
      issues.push(
        issue(
          "planner_graph_criterion_invalid",
          path,
          "Criterion fields are invalid.",
        ),
      );
      return [];
    }
    return [Object.freeze({ localId, description, verification })];
  });
  if (
    new Set(criteria.map(({ localId }) => localId)).size !== criteria.length
  ) {
    issues.push(
      issue(
        "planner_graph_criterion_ids_duplicate",
        `${nodePath}.acceptanceCriteria`,
        "Criterion local ids must be unique within a node.",
      ),
    );
  }
  return criteria.length === value.length ? Object.freeze(criteria) : undefined;
}

function validateTopology(
  nodes: readonly PlannerGraphNodeProposal[],
  issues: PlannerGraphValidationIssue[],
): void {
  const ids = new Set(nodes.map(({ localId }) => localId));
  for (const [index, node] of nodes.entries()) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push(
          issue(
            "planner_graph_dependency_unknown",
            `decision.nodes.${index}.dependsOn`,
            "Every dependency must reference one proposed node.",
          ),
        );
      }
      if (dependency === node.localId) {
        issues.push(
          issue(
            "planner_graph_dependency_self_reference",
            `decision.nodes.${index}.dependsOn`,
            "A node cannot depend on itself.",
          ),
        );
      }
    }
  }
  if (issues.some(({ code }) => code.startsWith("planner_graph_dependency_")))
    return;

  const remaining = new Set(ids);
  const completed = new Set<string>();
  let hasParallelFrontier = false;
  while (remaining.size > 0) {
    const frontier = nodes.filter(
      ({ localId, dependsOn }) =>
        remaining.has(localId) && dependsOn.every((id) => completed.has(id)),
    );
    if (frontier.length === 0) {
      issues.push(
        issue(
          "cyclic_plan_graph",
          "decision.nodes",
          "The proposed graph must be acyclic.",
        ),
      );
      return;
    }
    if (frontier.length >= 2) hasParallelFrontier = true;
    for (const node of frontier) {
      remaining.delete(node.localId);
      completed.add(node.localId);
    }
  }
  const dependedOn = new Set(nodes.flatMap(({ dependsOn }) => dependsOn));
  const terminalCount = nodes.filter(
    ({ localId }) => !dependedOn.has(localId),
  ).length;
  if (terminalCount < 2) {
    issues.push(
      issue(
        "insufficient_terminal_deliverables",
        "decision.nodes",
        "The graph must contain at least two independently accepted terminal deliverables.",
      ),
    );
  }
  if (!hasParallelFrontier) {
    issues.push(
      issue(
        "no_parallel_frontier",
        "decision.nodes",
        "The graph must expose at least one frontier with two ready nodes.",
      ),
    );
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: PlannerGraphValidationIssue[],
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expectedSet.has(key))
  ) {
    issues.push(
      issue(
        "planner_graph_keys_invalid",
        path,
        `Expected exactly: ${expected.join(", ")}.`,
      ),
    );
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= PLANNER_GRAPH_TEXT_MAX_LENGTH
    ? normalized
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= PLANNER_GRAPH_IDENTIFIER_MAX_LENGTH &&
    /^[a-zA-Z][a-zA-Z0-9._-]*$/u.test(value)
    ? value
    : undefined;
}

function identifierArray(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => identifier(entry) !== undefined) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return Object.freeze([...value] as string[]);
}

function issue(
  code: string,
  path: string,
  message: string,
): PlannerGraphValidationIssue {
  return Object.freeze({ code, path, message });
}

function rejected(
  stage: "json_envelope" | "domain_parser",
  issues: readonly PlannerGraphValidationIssue[],
): PlannerGraphParseResult {
  const bounded =
    issues.length <= PLANNER_GRAPH_VALIDATION_ISSUE_COUNT_MAX
      ? [...issues]
      : [
          ...issues.slice(0, PLANNER_GRAPH_VALIDATION_ISSUE_COUNT_MAX - 1),
          issue(
            "planner_graph_validation_issues_omitted",
            "decision",
            `${issues.length - (PLANNER_GRAPH_VALIDATION_ISSUE_COUNT_MAX - 1)} additional validation issues were omitted.`,
          ),
        ];
  return Object.freeze({
    ok: false as const,
    stage,
    issues: Object.freeze(bounded),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}
