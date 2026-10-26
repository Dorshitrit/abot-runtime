import type { ExecutionPolicyAuthoritySnapshot } from "../../orchestration/role-calls/contracts.js";
import type { SessionMemoryCompactor } from "../session-memory/contracts.js";
import { createModelSessionMemoryCompactor } from "../session-memory/index.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import { createSuperSessionMemoryCompactor } from "./history.js";

/** Internal service wiring; symbols never enter client JSON or saved state. */
export const SESSION_MEMORY_COMPACTORS = Symbol("session_memory_compactors");

export type SessionMemoryCompactors = Readonly<{
  legacy: SessionMemoryCompactor;
  super: SessionMemoryCompactor;
}>;

export type SessionMemoryCompactorComposition = Readonly<{
  [SESSION_MEMORY_COMPACTORS]?: SessionMemoryCompactors;
}>;

/** A genuine single override remains authoritative for both policies. */
export function composeSessionMemoryCompactors(
  override?: SessionMemoryCompactor,
  bound?: SessionMemoryCompactors,
): SessionMemoryCompactors {
  if (canReuseBoundSessionMemoryCompactors(override, bound)) return bound;
  if (override) return Object.freeze({ legacy: override, super: override });
  return Object.freeze({
    legacy: createModelSessionMemoryCompactor(),
    super: createSuperSessionMemoryCompactor(),
  });
}

function canReuseBoundSessionMemoryCompactors(
  override: SessionMemoryCompactor | undefined,
  bound: SessionMemoryCompactors | undefined,
): bound is SessionMemoryCompactors {
  return bound !== undefined && override === bound.legacy;
}

/** Select the author at request composition, including approval restore. */
export function resolvePolicySessionMemoryCompactor(
  legacy: SessionMemoryCompactor,
  superCompactor: SessionMemoryCompactor,
  authority: ExecutionPolicyAuthoritySnapshot,
): SessionMemoryCompactor {
  if (!hasSuperContextContract(authority, "supervisor")) return legacy;
  return superCompactor;
}
