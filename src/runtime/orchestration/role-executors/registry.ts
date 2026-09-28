import { RoleActivationLoop } from "./activation/loop.js";
import {
  isRoleApprovalWait,
  type RoleApprovalWait,
} from "./approval-continuation.js";
import { ChildInvocationTransaction } from "./child-invocation/transaction.js";
import type {
  RoleChildInvocationResult,
  RoleExecutionResult,
  RoleExecutor,
  RoleExecutorRegistry,
  RoleChildInvocationInput,
  RoleExecutionInput,
} from "./contracts.js";

export function createRoleExecutorRegistry<TContext, TValue = unknown>(
  executors: readonly RoleExecutor<TContext, TValue>[],
): RoleExecutorRegistry<TContext, TValue> {
  return new RoleExecutorRuntime(executors).registry;
}

class RoleExecutorRuntime<TContext, TValue> {
  private readonly byRoleId: ReadonlyMap<
    RoleExecutor<TContext, TValue>["roleId"],
    RoleExecutor<TContext, TValue>
  >;
  readonly roleIds: RoleExecutorRegistry<TContext, TValue>["roleIds"];
  readonly registry: RoleExecutorRegistry<TContext, TValue>;

  constructor(executors: readonly RoleExecutor<TContext, TValue>[]) {
    const byRoleId = new Map(
      executors.map((executor) => [executor.roleId, executor] as const),
    );
    if (byRoleId.size !== executors.length) {
      throw new Error("duplicate_role_executor");
    }

    this.byRoleId = byRoleId;
    this.roleIds = Object.freeze([...byRoleId.keys()]);
    this.registry = Object.freeze({
      roleIds: this.roleIds,
      invokeChild: this.invokeChild.bind(this) as RoleExecutorRegistry<
        TContext,
        TValue
      >["invokeChild"],
      execute: this.execute.bind(this) as RoleExecutorRegistry<
        TContext,
        TValue
      >["execute"],
    });
  }

  private async invokeChild(
    input: RoleChildInvocationInput<TContext>,
  ): Promise<RoleChildInvocationResult<TValue> | RoleApprovalWait> {
    const result = await new ChildInvocationTransaction({
      input,
      registeredRoleIds: this.roleIds,
      isRoleRegistered: (roleId) => this.byRoleId.has(roleId),
      executeRole: async (executionInput) => this.execute(executionInput),
    }).run();
    if (isRoleApprovalWait(result) && !input.allowApprovalWait)
      throw new Error("role_approval_wait_not_enabled");
    return result;
  }

  private async execute(
    input: RoleExecutionInput<TContext>,
  ): Promise<RoleExecutionResult<TValue> | RoleApprovalWait> {
    const result = await new RoleActivationLoop({
      input,
      registeredRoleIds: this.roleIds,
      executorByRoleId: this.byRoleId,
      invokeChild: async (childInput) => this.invokeChild(childInput),
    }).run();
    if (isRoleApprovalWait(result) && !input.allowApprovalWait)
      throw new Error("role_approval_wait_not_enabled");
    return result;
  }
}
