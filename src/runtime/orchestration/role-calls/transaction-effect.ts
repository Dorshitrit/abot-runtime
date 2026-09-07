import type {
  RoleCallCommitEffect,
  RoleCallLedgerCommit,
  RoleCallLedgerCommitResult,
  RoleCallTransactionResult,
} from "./contracts.js";

export function requireEffect<
  TEffectType extends RoleCallCommitEffect["type"],
  TTransitionIssueCode extends string,
>(
  commit: RoleCallLedgerCommitResult,
  effectType: TEffectType,
  invalidEffectIssueCode: TTransitionIssueCode,
  validate: (
    effect: Extract<RoleCallCommitEffect, { type: TEffectType }>,
  ) => boolean,
): RoleCallTransactionResult<TEffectType, TTransitionIssueCode> {
  if (!commit.ok) {
    return Object.freeze({ ok: false, issueCode: commit.code, commit });
  }
  if (commit.effect.type !== effectType)
    return invalidEffect(commit, invalidEffectIssueCode);
  const typedCommit = commit as RoleCallLedgerCommit &
    Readonly<{
      effect: Extract<RoleCallCommitEffect, { type: TEffectType }>;
    }>;
  if (!validate(typedCommit.effect))
    return invalidEffect(commit, invalidEffectIssueCode);
  return Object.freeze({ ok: true, commit: typedCommit });
}

export function invalidEffect<TTransitionIssueCode extends string>(
  commit: RoleCallLedgerCommit,
  issueCode: TTransitionIssueCode,
): RoleCallTransactionResult<never, TTransitionIssueCode> {
  return Object.freeze({ ok: false, issueCode, commit });
}
