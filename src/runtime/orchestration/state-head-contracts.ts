export const canonicalStateHeadBrand: unique symbol =
  Symbol("CanonicalStateHead");

/**
 * One exact, request-scoped view of canonical runtime state and policy.
 *
 * Public fields are immutable data for downstream projection. Write authority
 * comes only from exact object identity with the channel that issued the head;
 * a structural clone, cast, or head from another request has no authority.
 */
export type CanonicalStateHead<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
> = Readonly<{
  kind: TKind;
  revision: number;
  state: TState;
  policy: TPolicy;
  readonly [canonicalStateHeadBrand]: true;
}>;

export type CanonicalStateHeadCandidate<
  TState extends object,
  TPolicy extends object,
> = Readonly<{
  state: TState;
  policy: TPolicy;
}>;

export type CanonicalStateHeadCommitContext<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
> = Readonly<{
  previousHead: CanonicalStateHead<TKind, TState, TPolicy>;
  head: CanonicalStateHead<TKind, TState, TPolicy>;
}>;

export type CanonicalStateHeadAfterCommit<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
> = (context: CanonicalStateHeadCommitContext<TKind, TState, TPolicy>) => void;

export type CanonicalStateHeadCommitFailureCode =
  | "transaction_closed"
  | "invalid_candidate"
  | "candidate_not_frozen"
  | "invalid_after_commit_hook";

export type CanonicalStateHeadCommitResult<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> =
  | Readonly<{
      ok: true;
      status: "committed";
      previousHead: CanonicalStateHead<TKind, TState, TPolicy>;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
    }>
  | Readonly<{
      ok: false;
      status: "rejected";
      code: CanonicalStateHeadCommitFailureCode;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
      issues?: readonly TIssue[];
    }>
  | Readonly<{
      ok: false;
      status: "committed_with_fault";
      code: "after_commit_fault";
      previousHead: CanonicalStateHead<TKind, TState, TPolicy>;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
    }>;

export type CanonicalStateHeadTransaction<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> = Readonly<{
  /** The exact head that passed compare-and-set admission for this callback. */
  head: CanonicalStateHead<TKind, TState, TPolicy>;

  /**
   * Validates and installs one candidate synchronously. The optional hook runs
   * after the head advances and before commit returns, so a caller may invoke
   * commit while a narrower physical-resource lock is still held.
   */
  commit(
    candidate: CanonicalStateHeadCandidate<TState, TPolicy>,
    afterCommit?: CanonicalStateHeadAfterCommit<TKind, TState, TPolicy>,
  ): CanonicalStateHeadCommitResult<TKind, TState, TPolicy, TIssue>;
}>;

export type CanonicalStateHeadTransactionFailureCode =
  | "invalid_transaction_request"
  | "invalid_expected_head"
  | "stale_head"
  | CanonicalStateHeadCommitFailureCode
  | "transaction_callback_fault";

export type CanonicalStateHeadTransactionResult<
  T,
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> =
  | Readonly<{
      ok: true;
      status: "unchanged";
      head: CanonicalStateHead<TKind, TState, TPolicy>;
      value: T;
    }>
  | Readonly<{
      ok: true;
      status: "committed";
      previousHead: CanonicalStateHead<TKind, TState, TPolicy>;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
      value: T;
    }>
  | Readonly<{
      ok: false;
      status: "rejected";
      code: CanonicalStateHeadTransactionFailureCode;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
      issues?: readonly TIssue[];
    }>
  | Readonly<{
      ok: false;
      status: "committed_with_fault";
      code: "after_commit_fault" | "transaction_callback_fault";
      previousHead: CanonicalStateHead<TKind, TState, TPolicy>;
      head: CanonicalStateHead<TKind, TState, TPolicy>;
    }>;

export type CanonicalStateHeadReader<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
> = Readonly<{
  current(): CanonicalStateHead<TKind, TState, TPolicy>;
}>;

export type CanonicalStateHeadCommitObservers<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
> = Readonly<{
  /** Registers one trusted synchronous observer for every canonical commit. */
  subscribe(
    observer: CanonicalStateHeadAfterCommit<TKind, TState, TPolicy>,
  ): void;
}>;

export type CanonicalStateHeadWriter<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> = Readonly<{
  transaction<T>(
    input: Readonly<{
      expectedHead: unknown;
      run(
        transaction: CanonicalStateHeadTransaction<
          TKind,
          TState,
          TPolicy,
          TIssue
        >,
      ): Promise<T> | T;
    }>,
  ): Promise<
    CanonicalStateHeadTransactionResult<T, TKind, TState, TPolicy, TIssue>
  >;
}>;

export type CanonicalStateHeadChannel<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> = Readonly<{
  reader: CanonicalStateHeadReader<TKind, TState, TPolicy>;
  writer: CanonicalStateHeadWriter<TKind, TState, TPolicy, TIssue>;
  commits: CanonicalStateHeadCommitObservers<TKind, TState, TPolicy>;
}>;

export type CanonicalStateHeadCompositeValidator<
  TState extends object,
  TPolicy extends object,
  TIssue,
> = (
  candidate: CanonicalStateHeadCandidate<TState, TPolicy>,
) => readonly TIssue[];

export type CanonicalStateHeadFactory<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> = (
  input: CanonicalStateHeadCandidate<TState, TPolicy>,
  options?: Readonly<{ initialRevision: number }>,
) => CanonicalStateHeadChannel<TKind, TState, TPolicy, TIssue>;
