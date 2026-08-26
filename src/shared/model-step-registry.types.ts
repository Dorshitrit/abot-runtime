export type ModelInvocationStepOwner = "runtime-core" | "tool-extension";

export type ModelInvocationRole =
  | "chat"
  | "chatFinalization"
  | "supervisor"
  | "executor"
  | "planner"
  | "auditor"
  | "reviewer"
  | "worker"
  | "utility";

export type ModelInvocationLane = "main" | "fast" | "utility";

export type ModelInvocationFormat = "text" | "json" | "raw";

export type ModelInvocationAttachmentPolicy = "conversation" | "none";

export type ModelInvocationOutputTokenPolicy = "core_decision";

export type RegisteredModelInvocationStepDefinition = {
  readonly id: string;
  readonly owner: ModelInvocationStepOwner;
  readonly role: ModelInvocationRole;
  readonly lane: ModelInvocationLane;
  readonly defaultFormat: ModelInvocationFormat;
  readonly outputContract: string;
  readonly outputTokenPolicy?: ModelInvocationOutputTokenPolicy;
  readonly attachmentPolicy?: ModelInvocationAttachmentPolicy;
};

export type ModelInvocationStepDefinition =
  RegisteredModelInvocationStepDefinition & {
    readonly key?: string;
  };
