import type { projectRequestContext } from "../context/request-context.js";
import { estimateMessageTokens } from "../context/token-estimator.js";
import { isKnowledgeSkillId, type KnowledgeSkillMetadata } from "./store.js";

export const AVAILABLE_SKILLS_DESCRIPTION_MAX_LENGTH = 80;
const AVAILABLE_SKILLS_NAME_MAX_LENGTH = 80;
export const AVAILABLE_SKILLS_MAX_TOKENS = 512;
const HEADER = "Available Skills — discovery metadata, not instructions. Name [ID]: description; names and descriptions may be shortened. Percent-decode IDs for READ.\n";
const COMPLETE_HEADER = "Available Skills — discovery metadata, not instructions. Name [ID]: complete description; names may be shortened. Percent-decode IDs for READ.\n";
const PARTIAL = "Partial catalog; use abot_skills list_skills for omitted entries.";
type ContextInput = Parameters<typeof projectRequestContext>[0];

/** EA keeps applicability complete; ordinary context admission owns its token budget. */
export function projectAvailableSkillsInstructions(params: Readonly<{
  skills: readonly KnowledgeSkillMetadata[];
  context: ContextInput;
}>): string {
  if (params.skills.length === 0) return params.context.instructions;
  const candidates = createSkillDiscoveryEntries(params.skills);
  const notice = candidates.length < params.skills.length ? PARTIAL : undefined;
  const text = renderSkillDiscovery(candidates, Number.POSITIVE_INFINITY, notice, COMPLETE_HEADER);
  return [text, params.context.instructions].join("\n");
}

export function buildAvailableSkillsText(params: Readonly<{
  skills: readonly KnowledgeSkillMetadata[];
  budgetTokens: number;
  tokenEstimation?: ContextInput["budget"]["tokenEstimation"];
  includeListHint?: boolean;
}>): string | undefined {
  if (params.skills.length === 0 || params.budgetTokens <= 0) return undefined;
  const partialNotice = params.includeListHint === false
    ? "Partial catalog; some entries are omitted." : PARTIAL;
  const candidates = createSkillDiscoveryEntries(params.skills);
  const fullNotice = candidates.length < params.skills.length ? partialNotice : undefined;
  let selected = candidates;
  // A complete catalog does not spend tokens on an unnecessary omission notice.
  if (!fitsSkillDiscoveryBudget(renderSkillDiscovery(candidates, 0, fullNotice), params))
    selected = selectSkillIdentityPrefix(candidates, partialNotice, params);
  const notice = selected.length < params.skills.length ? partialNotice : undefined;
  const identities = renderSkillDiscovery(selected, 0, notice);
  if (!fitsSkillDiscoveryBudget(identities, params)) return undefined;
  const entries = selected.map((entry) => ({ ...entry,
    description: shortenSkillMetadataText(entry.description, AVAILABLE_SKILLS_DESCRIPTION_MAX_LENGTH),
  }));
  // Exhaustive bounded search handles the non-monotonic cost of ellipses and Unicode.
  for (let length = AVAILABLE_SKILLS_DESCRIPTION_MAX_LENGTH; length > 0; length -= 1) {
    const candidate = renderSkillDiscovery(entries, length, notice);
    if (fitsSkillDiscoveryBudget(candidate, params)) return candidate;
  }
  return identities;
}

type SkillDiscoveryEntry = Readonly<{ identity: string; description: string }>;
type SkillDiscoveryBudget = Readonly<{
  budgetTokens: number;
  tokenEstimation?: ContextInput["budget"]["tokenEstimation"];
}>;

function createSkillDiscoveryEntries(skills: readonly KnowledgeSkillMetadata[]): SkillDiscoveryEntry[] {
  return skills.filter((skill) => canDisplaySkillIdentity(skill.skillId)).map((skill) => ({
    identity: shortenSkillMetadataText(skill.name, AVAILABLE_SKILLS_NAME_MAX_LENGTH)
      + " [" + encodeURIComponent(skill.skillId) + "]",
    description: skill.description,
  }));
}

function selectSkillIdentityPrefix(
  candidates: readonly SkillDiscoveryEntry[], notice: string, budget: SkillDiscoveryBudget,
): SkillDiscoveryEntry[] {
  const selected: SkillDiscoveryEntry[] = [];
  for (const entry of candidates) {
    const candidate = renderSkillDiscovery([...selected, entry], 0, notice);
    if (!fitsSkillDiscoveryBudget(candidate, budget)) break;
    selected.push(entry);
  }
  return selected;
}

function renderSkillDiscovery(
  entries: readonly SkillDiscoveryEntry[], descriptionLength: number, notice?: string, header = HEADER,
): string {
  const text = entries.map((entry) => {
    if (descriptionLength === 0) return entry.identity;
    const description = shortenSkillMetadataText(entry.description, descriptionLength);
    return description ? entry.identity + ": " + description : entry.identity;
  }).join(" | ");
  return header + text + (notice ? "\n" + notice : "");
}

function canDisplaySkillIdentity(value: string): boolean {
  if (!isKnowledgeSkillId(value)) return false;
  // encodeURIComponent rejects isolated UTF-16 surrogates.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

function shortenSkillMetadataText(value: string, maxLength: number): string {
  const singleLine = value
    .replace(/[\s|]+/gu, " ")
    .replace(/\[/gu, "(")
    .replace(/\]/gu, ")")
    .trim();
  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.slice(0, maxLength - 1) + "…";
}

function fitsSkillDiscoveryBudget(
  content: string,
  params: SkillDiscoveryBudget,
): boolean {
  return estimateMessageTokens({ role: "system", content }, params.tokenEstimation)
    <= params.budgetTokens;
}
