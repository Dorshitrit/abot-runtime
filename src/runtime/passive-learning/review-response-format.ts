import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { MAX_LEARNING_DECISIONS } from "../long-term-memory/maturation/decisions.js";
import { MAX_MEMORY_CONTENT_CHARACTERS } from "../long-term-memory/policies/normalization.js";
import type { LearningReviewReferences } from "./review-references.js";

const knowledgeProperties = {
  content: { type: "string", maxLength: MAX_MEMORY_CONTENT_CHARACTERS },
  tags: { type: "array", maxItems: 12, items: { type: "string" } },
  score: { type: "integer", minimum: 0, maximum: 100 },
  reason: { type: "string", maxLength: 1000 },
  certainty: { type: "string", enum: ["observed", "inferred"] },
  reconsiderAt: { type: ["string", "null"] },
};
type DecisionSchema = ReturnType<typeof decisionSchema>;

/** Offer only applicable actions and exact short references for this one review. */
export function createLearningReviewFormat(references: LearningReviewReferences): ModelGatewayJsonSchemaFormat {
  const variants = reviewDecisionVariants(references);
  const items = variants.length === 1 ? variants[0]! : { anyOf: variants };
  const postValidatedSchemaConstraints = variants.flatMap((variant, index) => {
    const path = variants.length === 1 ? "/properties/decisions/items" : `/properties/decisions/items/anyOf/${index}`;
    return ["content", "reason"].filter((field) => Object.hasOwn(variant.properties, field)).map((field) => ({
      keyword: "maxLength" as const, path: `${path}/properties/${field}/maxLength`,
    }));
  });
  return {
    type: "json_schema", name: "learning_review_decisions_v2", strict: true,
    postValidatedSchemaConstraints,
    schema: {
      type: "object", additionalProperties: false, required: ["decisions"],
      properties: { decisions: { type: "array", maxItems: variants.length ? MAX_LEARNING_DECISIONS : 0,
        items: variants.length ? items : decisionSchema({}),
      } },
    },
  };
}

function reviewDecisionVariants(references: LearningReviewReferences): DecisionSchema[] {
  if (!references.scheduled && !references.evidence.size) return [];
  const evidence = references.scheduled ? {} : {
    evidence: { type: "array", minItems: 1, maxItems: 16,
      items: { type: "string", enum: [...references.evidence.keys()] } },
  };
  const variants: DecisionSchema[] = [];
  if (!references.scheduled) variants.push(decisionSchema({
    action: actionProperty("create"), ...knowledgeProperties, ...evidence,
  }));
  if (!references.targetRefs.length) return variants;
  const target = { type: "string", enum: references.targetRefs };
  const reinforcement = references.scheduled ? {} : { reinforced: { type: "boolean" } };
  variants.push(decisionSchema({ action: actionProperty("update"), target,
    ...knowledgeProperties, ...evidence, ...reinforcement,
  }));
  variants.push(decisionSchema({ action: actionProperty("remove"), target,
    reason: knowledgeProperties.reason, ...evidence,
  }));
  for (const { targetRef, sourceRefs } of candidateMergeChoices(references)) variants.push(decisionSchema({
    action: actionProperty("merge"), target: { type: "string", enum: [targetRef] },
    ...knowledgeProperties, ...evidence, ...reinforcement,
    sources: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", enum: sourceRefs } },
  }));
  return variants;
}

function candidateMergeChoices(references: LearningReviewReferences) {
  if (references.scheduled) return [];
  return references.targetRefs.map((targetRef) => ({
    targetRef, sourceRefs: references.mergeRefs.filter((source) => source !== targetRef),
  })).filter(({ sourceRefs }) => sourceRefs.length > 0);
}
function actionProperty(action: string) { return { type: "string", enum: [action] }; }
function decisionSchema(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
