import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { createMemoryRecallDecisionSchema } from "../memory-recall-decision.js";
import {
  createStructuredDecisionEnvelopeSchema,
  structuredDecisionVariantSchemaPath,
} from "../../model/structured-decision-envelope.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import { SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH } from "./response-recommendation.js";
import { createWorkerCapabilityScopeDecisionContract } from "../worker-capability-scope-decision.js";
import {
  SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
  SUPERVISOR_DELEGATE_ROLE_IDS,
  SUPERVISOR_OBJECTIVE_MAX_LENGTH,
  SUPERVISOR_TITLE_MAX_LENGTH,
  type SupervisorDelegateRoleId,
} from "./contracts.js";

export function createSupervisorDecisionFormat(
  params: Readonly<{
    includeAcknowledgement?: boolean;
    includeTitle?: boolean;
    includeResponseRecommendation?: boolean;
    allowMemoryRecall?: boolean;
    allowedRoleIds?: readonly SupervisorDelegateRoleId[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
  }> = {},
): ModelGatewayJsonSchemaFormat {
  const allowedRoleIds = uniqueRoleIds(
    params.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS,
  );
  const includeAcknowledgement = params.includeAcknowledgement === true;
  const includeTitle = params.includeTitle === true;
  const includeResponseRecommendation =
    params.includeResponseRecommendation === true;
  const availableWorkerCapabilityCatalog =
    params.availableWorkerCapabilityCatalog ?? [];
  const workerCapabilityScopeContract =
    createWorkerCapabilityScopeDecisionContract(
      availableWorkerCapabilityCatalog,
    );
  const workerAvailable = allowedRoleIds.includes("worker");
  const reviewerAvailable = allowedRoleIds.includes("reviewer");
  const objectiveRoleIds = allowedRoleIds.filter(
    (roleId): roleId is Exclude<SupervisorDelegateRoleId, "reviewer"> =>
      roleId !== "reviewer",
  );
  const scopedWorkerRequired =
    workerAvailable && workerCapabilityScopeContract.required;
  const unscopedObjectiveRoleIds = objectiveRoleIds.filter(
    (roleId) => roleId !== "worker" || !scopedWorkerRequired,
  );
  const objectiveInvokeVariants = [
    ...(scopedWorkerRequired
      ? [
          invokeRoleSchema(
            includeAcknowledgement,
            includeTitle,
            ["worker"],
            workerCapabilityScopeContract.schema,
          ),
        ]
      : []),
    ...(unscopedObjectiveRoleIds.length > 0
      ? [
          invokeRoleSchema(
            includeAcknowledgement,
            includeTitle,
            unscopedObjectiveRoleIds,
          ),
        ]
      : []),
  ];
  const invokeVariants = [
    ...objectiveInvokeVariants,
    ...(reviewerAvailable
      ? [
          invokeRoleSchema(
            includeAcknowledgement,
            includeTitle,
            ["reviewer"],
            undefined,
            false,
          ),
        ]
      : []),
  ];
  const variants = [
    respondSchema(
      includeAcknowledgement,
      includeTitle,
      includeResponseRecommendation,
    ),
    ...invokeVariants,
    ...(params.allowMemoryRecall
      ? [
          createMemoryRecallDecisionSchema({
            includeAcknowledgement,
            includeTitle,
            acknowledgementMaxLength: SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
            titleMaxLength: SUPERVISOR_TITLE_MAX_LENGTH,
          }),
        ]
      : []),
  ];
  return {
    type: "json_schema",
    name: "supervisor_decision",
    strict: true,
    postValidatedSchemaConstraints: createPostValidatedConstraints({
      includeAcknowledgement,
      includeTitle,
      includeResponseRecommendation,
      variantCount: variants.length,
      invokeVariantCount: invokeVariants.length,
      objectiveInvokeVariantCount: objectiveInvokeVariants.length,
      allowMemoryRecall: params.allowMemoryRecall === true,
    }),
    schema: createStructuredDecisionEnvelopeSchema(variants),
  };
}

function respondSchema(
  includeAcknowledgement: boolean,
  includeTitle: boolean,
  includeResponseRecommendation: boolean,
): Record<string, unknown> {
  return exactObject(
    {
      action: literal("respond"),
      ...(includeResponseRecommendation
        ? {
            responseRecommendation: boundedText(
              SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH,
            ),
          }
        : {}),
      ...(includeAcknowledgement
        ? {
            acknowledgement: boundedText(
              SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
              2,
            ),
          }
        : {}),
      ...(includeTitle
        ? { title: boundedText(SUPERVISOR_TITLE_MAX_LENGTH, 2) }
        : {}),
    },
    [
      "action",
      ...(includeResponseRecommendation ? ["responseRecommendation"] : []),
      ...(includeAcknowledgement ? ["acknowledgement"] : []),
      ...(includeTitle ? ["title"] : []),
    ],
  );
}

function invokeRoleSchema(
  includeAcknowledgement: boolean,
  includeTitle: boolean,
  allowedRoleIds: readonly SupervisorDelegateRoleId[],
  workerCapabilityScopeSchema?: Record<string, unknown>,
  includeObjective = true,
): Record<string, unknown> {
  return exactObject(
    {
      action: literal("invoke_role"),
      roleId: {
        type: "string",
        enum: [...allowedRoleIds],
      },
      ...(includeObjective
        ? { objective: boundedText(SUPERVISOR_OBJECTIVE_MAX_LENGTH) }
        : {}),
      ...(workerCapabilityScopeSchema
        ? { workerCapabilityScope: workerCapabilityScopeSchema }
        : {}),
      ...(includeAcknowledgement
        ? {
            acknowledgement: boundedText(
              SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH,
              2,
            ),
          }
        : {}),
      ...(includeTitle
        ? { title: boundedText(SUPERVISOR_TITLE_MAX_LENGTH, 2) }
        : {}),
    },
    [
      "action",
      "roleId",
      ...(includeObjective ? ["objective"] : []),
      ...(workerCapabilityScopeSchema ? ["workerCapabilityScope"] : []),
      ...(includeAcknowledgement ? ["acknowledgement"] : []),
      ...(includeTitle ? ["title"] : []),
    ],
  );
}

function createPostValidatedConstraints(params: {
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  includeResponseRecommendation: boolean;
  variantCount: number;
  invokeVariantCount: number;
  objectiveInvokeVariantCount: number;
  allowMemoryRecall: boolean;
}): Array<{ keyword: "maxLength"; path: string }> {
  const base = (index: number) =>
    structuredDecisionVariantSchemaPath(index, params.variantCount);
  return [
    ...(params.allowMemoryRecall
      ? [
          "query",
          ...(params.includeAcknowledgement ? ["acknowledgement"] : []),
          ...(params.includeTitle ? ["title"] : []),
        ].map((field) => ({
          keyword: "maxLength" as const,
          path: `${base(params.variantCount - 1)}/properties/${field}/maxLength`,
        }))
      : []),
    ...(params.includeResponseRecommendation
      ? [
          {
            keyword: "maxLength" as const,
            path: `${base(0)}/properties/responseRecommendation/maxLength`,
          },
        ]
      : []),
    ...(params.includeAcknowledgement
      ? [
          {
            keyword: "maxLength" as const,
            path: `${base(0)}/properties/acknowledgement/maxLength`,
          },
        ]
      : []),
    ...(params.includeTitle
      ? [
          {
            keyword: "maxLength" as const,
            path: `${base(0)}/properties/title/maxLength`,
          },
        ]
      : []),
    ...Array.from(
      { length: params.objectiveInvokeVariantCount },
      (_, index) => index + 1,
    ).map((index) => ({
      keyword: "maxLength" as const,
      path: `${base(index)}/properties/objective/maxLength`,
    })),
    ...Array.from(
      { length: params.invokeVariantCount },
      (_, index) => index + 1,
    ).flatMap((index) => [
      ...(params.includeAcknowledgement
        ? [
            {
              keyword: "maxLength" as const,
              path: `${base(index)}/properties/acknowledgement/maxLength`,
            },
          ]
        : []),
      ...(params.includeTitle
        ? [
            {
              keyword: "maxLength" as const,
              path: `${base(index)}/properties/title/maxLength`,
            },
          ]
        : []),
    ]),
  ];
}

function uniqueRoleIds(
  roleIds: readonly SupervisorDelegateRoleId[],
): readonly SupervisorDelegateRoleId[] {
  return [...new Set(roleIds)];
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return { type: "string", enum: [value] };
}

function boundedText(
  maxLength: number,
  minLength: number = 1,
): Record<string, unknown> {
  return {
    type: "string",
    minLength,
    maxLength,
  };
}
