import { consumeUnexpectedThenable } from "./synchronous-boundary.js";

const canonicalStateHeadBrand: unique symbol = Symbol("CanonicalStateHead");

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
) => CanonicalStateHeadChannel<TKind, TState, TPolicy, TIssue>;

/**
 * Configures the shared canonical-head mechanism for one runtime state shape.
 * The caller supplies only its compatibility kind and synchronous composite
 * validator; compare-and-set, freezing, revision, and observer semantics stay
 * owned here.
 */
export function createCanonicalStateHeadFactory<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
>(
  options: Readonly<{
    compatibilityHeadKind: TKind;
    validationLabel: string;
    validateCandidate: CanonicalStateHeadCompositeValidator<
      TState,
      TPolicy,
      TIssue
    >;
  }>,
): CanonicalStateHeadFactory<TKind, TState, TPolicy, TIssue> {
  const compatibilityHeadKind = options.compatibilityHeadKind;
  const validationLabel = options.validationLabel;
  const validateCandidate = options.validateCandidate;
  if (
    typeof compatibilityHeadKind !== "string" ||
    !compatibilityHeadKind ||
    typeof validationLabel !== "string" ||
    !validationLabel ||
    typeof validateCandidate !== "function"
  ) {
    throw new TypeError("Invalid canonical state-head factory options.");
  }

  return function createCanonicalStateHead(
    input: CanonicalStateHeadCandidate<TState, TPolicy>,
  ): CanonicalStateHeadChannel<TKind, TState, TPolicy, TIssue> {
    const initialCandidate = captureValidatedCandidate(
      input,
      validateCandidate,
    );
    if (!initialCandidate.ok) {
      throw new TypeError(
        `Cannot create a ${validationLabel}: ${initialCandidate.code}.`,
      );
    }

    const issuedHeads = new WeakSet<object>();
    const commitObservers = new Set<
      CanonicalStateHeadAfterCommit<TKind, TState, TPolicy>
    >();
    let currentHead = issueHead(
      compatibilityHeadKind,
      0,
      initialCandidate.candidate.state,
      initialCandidate.candidate.policy,
      issuedHeads,
    );
    let writerTail: Promise<void> = Promise.resolve();

    const reader: CanonicalStateHeadReader<TKind, TState, TPolicy> =
      Object.freeze({
        current() {
          return currentHead;
        },
      });

    const writer: CanonicalStateHeadWriter<TKind, TState, TPolicy, TIssue> =
      Object.freeze({
        transaction<T>(
          transactionInput: Readonly<{
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
        > {
          const capturedInput = captureTransactionInput<
            T,
            TKind,
            TState,
            TPolicy,
            TIssue
          >(transactionInput);
          const execute = () =>
            executeTransaction<T, TKind, TState, TPolicy, TIssue>({
              transactionInput: capturedInput,
              compatibilityHeadKind,
              validateCandidate,
              issuedHeads,
              readCurrent: () => currentHead,
              installCurrent: (head) => {
                currentHead = head;
              },
              commitObservers,
            });
          const result = writerTail.then(execute, execute);
          writerTail = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        },
      });

    const commits: CanonicalStateHeadCommitObservers<TKind, TState, TPolicy> =
      Object.freeze({
        subscribe(observer) {
          if (typeof observer !== "function") {
            throw new TypeError(
              "A synchronous state-head commit observer is required.",
            );
          }
          commitObservers.add(observer);
        },
      });

    return Object.freeze({ reader, writer, commits });
  };
}

type CapturedCanonicalStateHeadTransactionInput<
  T,
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
> =
  | Readonly<{
      ok: true;
      expectedHead: unknown;
      run(
        transaction: CanonicalStateHeadTransaction<
          TKind,
          TState,
          TPolicy,
          TIssue
        >,
      ): Promise<T> | T;
    }>
  | Readonly<{ ok: false }>;

function captureTransactionInput<
  T,
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
>(
  input: unknown,
): CapturedCanonicalStateHeadTransactionInput<
  T,
  TKind,
  TState,
  TPolicy,
  TIssue
> {
  try {
    if (typeof input !== "object" || input === null) {
      return Object.freeze({ ok: false });
    }
    const expectedHead = (input as { expectedHead?: unknown }).expectedHead;
    const run = (input as { run?: unknown }).run;
    if (typeof run !== "function") return Object.freeze({ ok: false });
    return Object.freeze({
      ok: true,
      expectedHead,
      run: run as (
        transaction: CanonicalStateHeadTransaction<
          TKind,
          TState,
          TPolicy,
          TIssue
        >,
      ) => Promise<T> | T,
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

async function executeTransaction<
  T,
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
>(params: {
  transactionInput: CapturedCanonicalStateHeadTransactionInput<
    T,
    TKind,
    TState,
    TPolicy,
    TIssue
  >;
  compatibilityHeadKind: TKind;
  validateCandidate: CanonicalStateHeadCompositeValidator<
    TState,
    TPolicy,
    TIssue
  >;
  issuedHeads: WeakSet<object>;
  readCurrent(): CanonicalStateHead<TKind, TState, TPolicy>;
  installCurrent(head: CanonicalStateHead<TKind, TState, TPolicy>): void;
  commitObservers: ReadonlySet<
    CanonicalStateHeadAfterCommit<TKind, TState, TPolicy>
  >;
}): Promise<
  CanonicalStateHeadTransactionResult<T, TKind, TState, TPolicy, TIssue>
> {
  if (!params.transactionInput.ok) {
    return rejectedTransaction(
      "invalid_transaction_request",
      params.readCurrent(),
    );
  }
  const { expectedHead, run } = params.transactionInput;
  if (
    typeof expectedHead !== "object" ||
    expectedHead === null ||
    !params.issuedHeads.has(expectedHead)
  ) {
    return rejectedTransaction("invalid_expected_head", params.readCurrent());
  }

  const admittedHead = params.readCurrent();
  if (expectedHead !== admittedHead) {
    return rejectedTransaction("stale_head", admittedHead);
  }

  let open = true;
  let commitUsed = false;
  let commitResult:
    | CanonicalStateHeadCommitResult<TKind, TState, TPolicy, TIssue>
    | undefined;
  const transaction: CanonicalStateHeadTransaction<
    TKind,
    TState,
    TPolicy,
    TIssue
  > = Object.freeze({
    head: admittedHead,
    commit(
      candidate: CanonicalStateHeadCandidate<TState, TPolicy>,
      afterCommit?: CanonicalStateHeadAfterCommit<TKind, TState, TPolicy>,
    ): CanonicalStateHeadCommitResult<TKind, TState, TPolicy, TIssue> {
      if (!open || commitUsed) {
        return rejectedCommit("transaction_closed", params.readCurrent());
      }
      commitUsed = true;
      if (afterCommit !== undefined && typeof afterCommit !== "function") {
        commitResult = rejectedCommit(
          "invalid_after_commit_hook",
          params.readCurrent(),
        );
        return commitResult;
      }
      const capturedCandidate = captureValidatedCandidate(
        candidate,
        params.validateCandidate,
      );
      if (!capturedCandidate.ok) {
        commitResult = rejectedCommit(
          capturedCandidate.code,
          params.readCurrent(),
          capturedCandidate.issues,
        );
        return commitResult;
      }

      const previousHead = params.readCurrent();
      const head = issueHead(
        params.compatibilityHeadKind,
        previousHead.revision + 1,
        capturedCandidate.candidate.state,
        capturedCandidate.candidate.policy,
        params.issuedHeads,
      );
      params.installCurrent(head);

      let postCommitFault = false;
      const context = Object.freeze({ previousHead, head });
      for (const observer of [...params.commitObservers]) {
        try {
          const observerResult = observer(context);
          if (consumeUnexpectedThenable(observerResult)) {
            postCommitFault = true;
          }
        } catch {
          postCommitFault = true;
        }
      }
      if (afterCommit) {
        try {
          const hookResult = afterCommit(context);
          if (consumeUnexpectedThenable(hookResult)) {
            postCommitFault = true;
          }
        } catch {
          postCommitFault = true;
        }
      }
      if (postCommitFault) {
        commitResult = Object.freeze({
          ok: false,
          status: "committed_with_fault",
          code: "after_commit_fault",
          previousHead,
          head,
        });
        return commitResult;
      }

      commitResult = Object.freeze({
        ok: true,
        status: "committed",
        previousHead,
        head,
      });
      return commitResult;
    },
  });

  let value: T;
  try {
    value = await run(transaction);
  } catch {
    open = false;
    if (commitResult?.status === "committed") {
      return Object.freeze({
        ok: false,
        status: "committed_with_fault",
        code: "transaction_callback_fault",
        previousHead: commitResult.previousHead,
        head: commitResult.head,
      });
    }
    if (commitResult?.status === "committed_with_fault") {
      return commitResult;
    }
    return rejectedTransaction(
      "transaction_callback_fault",
      params.readCurrent(),
    );
  }
  open = false;

  if (!commitResult) {
    return Object.freeze({
      ok: true,
      status: "unchanged",
      head: admittedHead,
      value,
    });
  }
  if (commitResult.status === "rejected") {
    return Object.freeze({
      ok: false,
      status: "rejected",
      code: commitResult.code,
      head: commitResult.head,
      ...(commitResult.issues ? { issues: commitResult.issues } : {}),
    });
  }
  if (commitResult.status === "committed_with_fault") {
    return commitResult;
  }
  return Object.freeze({
    ok: true,
    status: "committed",
    previousHead: commitResult.previousHead,
    head: commitResult.head,
    value,
  });
}

function issueHead<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
>(
  compatibilityHeadKind: TKind,
  revision: number,
  state: TState,
  policy: TPolicy,
  issuedHeads: WeakSet<object>,
): CanonicalStateHead<TKind, TState, TPolicy> {
  const head: CanonicalStateHead<TKind, TState, TPolicy> = Object.freeze({
    kind: compatibilityHeadKind,
    revision,
    state,
    policy,
    [canonicalStateHeadBrand]: true as const,
  });
  issuedHeads.add(head);
  return head;
}

type CapturedCanonicalStateHeadCandidate<
  TState extends object,
  TPolicy extends object,
  TIssue,
> =
  | Readonly<{
      ok: true;
      candidate: CanonicalStateHeadCandidate<TState, TPolicy>;
    }>
  | Readonly<{
      ok: false;
      code: "invalid_candidate" | "candidate_not_frozen";
      issues?: readonly TIssue[];
    }>;

function captureValidatedCandidate<
  TState extends object,
  TPolicy extends object,
  TIssue,
>(
  value: unknown,
  validateCandidate: CanonicalStateHeadCompositeValidator<
    TState,
    TPolicy,
    TIssue
  >,
): CapturedCanonicalStateHeadCandidate<TState, TPolicy, TIssue> {
  try {
    const candidate = captureCandidateDescriptorValues<TState, TPolicy>(value);
    if (!candidate) {
      return Object.freeze({ ok: false, code: "invalid_candidate" as const });
    }
    if (
      !isRecursivelyFrozenData(candidate.state) ||
      !isRecursivelyFrozenData(candidate.policy)
    ) {
      return Object.freeze({
        ok: false,
        code: "candidate_not_frozen" as const,
      });
    }
    const issues = validateCandidate(candidate);
    if (!Array.isArray(issues)) {
      return Object.freeze({ ok: false, code: "invalid_candidate" as const });
    }
    if (issues.length > 0) {
      return Object.freeze({
        ok: false,
        code: "invalid_candidate" as const,
        issues: Object.freeze([...issues]) as readonly TIssue[],
      });
    }
    return Object.freeze({ ok: true, candidate });
  } catch {
    return Object.freeze({ ok: false, code: "invalid_candidate" as const });
  }
}

function captureCandidateDescriptorValues<
  TState extends object,
  TPolicy extends object,
>(value: unknown): CanonicalStateHeadCandidate<TState, TPolicy> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2 ||
      !keys.includes("state") ||
      !keys.includes("policy")
    ) {
      return undefined;
    }
    const state = descriptors.state;
    const policy = descriptors.policy;
    if (
      !state ||
      !("value" in state) ||
      !state.enumerable ||
      !policy ||
      !("value" in policy) ||
      !policy.enumerable
    ) {
      return undefined;
    }
    return Object.freeze({
      state: state.value as TState,
      policy: policy.value as TPolicy,
    });
  } catch {
    return undefined;
  }
}

function isRecursivelyFrozenData(
  value: unknown,
  visiting = new WeakSet<object>(),
  validated = new WeakSet<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (validated.has(value)) return true;
  if (visiting.has(value)) return false;
  visiting.add(value);
  try {
    if (!Object.isFrozen(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const valid = Reflect.ownKeys(descriptors).every((key) => {
      if (Array.isArray(value) && key === "length") return true;
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return (
        Boolean(descriptor) &&
        "value" in descriptor! &&
        isRecursivelyFrozenData(descriptor!.value, visiting, validated)
      );
    });
    if (valid) validated.add(value);
    return valid;
  } catch {
    return false;
  } finally {
    visiting.delete(value);
  }
}

function rejectedCommit<
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
>(
  code: CanonicalStateHeadCommitFailureCode,
  head: CanonicalStateHead<TKind, TState, TPolicy>,
  issues?: readonly TIssue[],
): CanonicalStateHeadCommitResult<TKind, TState, TPolicy, TIssue> {
  return Object.freeze({
    ok: false,
    status: "rejected",
    code,
    head,
    ...(issues ? { issues } : {}),
  });
}

function rejectedTransaction<
  T,
  TKind extends string,
  TState extends object,
  TPolicy extends object,
  TIssue,
>(
  code: CanonicalStateHeadTransactionFailureCode,
  head: CanonicalStateHead<TKind, TState, TPolicy>,
  issues?: readonly TIssue[],
): CanonicalStateHeadTransactionResult<T, TKind, TState, TPolicy, TIssue> {
  return Object.freeze({
    ok: false,
    status: "rejected",
    code,
    head,
    ...(issues ? { issues } : {}),
  });
}
