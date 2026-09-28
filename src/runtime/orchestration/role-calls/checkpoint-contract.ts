import type { RoleCallPolicy, RoleCallState } from "./contracts.js";

/** Trusted runtime persistence only; never accepted as model or client input. */
export type RoleCallLedgerCheckpoint = Readonly<{
  kind: "role_call_checkpoint_v1";
  revision: number;
  state: RoleCallState;
  policy: RoleCallPolicy;
}>;
