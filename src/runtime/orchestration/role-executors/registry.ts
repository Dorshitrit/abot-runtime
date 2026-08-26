import { RoleActivationLoop } from "./activation/loop.js";
import { ChildInvocationTransaction } from "./child-invocation/transaction.js";
import type {
  RoleChildInvocationResult,
  RoleExecutionResult,
  RoleExecutor,
  RoleExecutorRegistry,
} from "./contracts.js";

type RoleChildInvocationInput<TContext, TValue> = Parameters<
  RoleExecutorRegistry<TContext, TValue>["invokeChild"]
>[0];

type RoleExecutionInput<TContext, TValue> = Parameters<
  RoleExecutorRegistry<TContext, TValue>["execute"]
>[0];

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
      invokeChild: async (input) => this.invokeChild(input),
      execute: async (input) => this.execute(input),
    });
  }

  private invokeChild(
    input: RoleChildInvocationInput<TContext, TValue>,
  ): Promise<RoleChildInvocationResult<TValue>> {
    return new ChildInvocationTransaction({
      input,
      registeredRoleIds: this.roleIds,
      isRoleRegistered: (roleId) => this.byRoleId.has(roleId),
      executeRole: async (executionInput) => this.execute(executionInput),
    }).run();
  }

  private execute(
    input: RoleExecutionInput<TContext, TValue>,
  ): Promise<RoleExecutionResult<TValue>> {
    return new RoleActivationLoop({
      input,
      registeredRoleIds: this.roleIds,
      executorByRoleId: this.byRoleId,
      invokeChild: async (childInput) => this.invokeChild(childInput),
    }).run();
  }
}
