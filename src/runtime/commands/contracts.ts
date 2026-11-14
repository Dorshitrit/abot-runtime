/** Availability belongs to each command, not to the command transport. */
export type RuntimeCommandMode = "run" | "steer";

export type RuntimeCommandInvocation = Readonly<{
  name: string;
  arguments?: Readonly<Record<string, unknown>>;
}> &
  (
    | Readonly<{ mode: "run"; targetRequestId?: never }>
    | Readonly<{ mode: "steer"; targetRequestId: string }>
  );

export type RuntimeCommandDefinition = Readonly<{
  name: string;
  description: string;
  modes: readonly RuntimeCommandMode[];
  arguments: Readonly<{ type: "object"; additionalProperties: false }>;
}>;

export type RuntimeCommandResult = Readonly<{
  eventName: string;
  outcome: string;
  details?: Readonly<Record<string, unknown>>;
}>;
