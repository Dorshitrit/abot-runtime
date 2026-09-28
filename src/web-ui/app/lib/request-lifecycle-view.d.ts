export declare function isApprovalPresentation(
  message: Record<string, any>,
): boolean;
export declare function projectApprovalContinuations<T extends Record<string, any>>(
  messages: T[],
): T[];
export declare function requestLifecycles(
  state: Record<string, any>,
): Map<string, any>;
export declare function rememberRequestLifecycle(
  state: Record<string, any>,
  lifecycle: any,
): boolean;
export declare function hasWaitingApproval(state: Record<string, any>): boolean;
export declare function waitingRequest(state: Record<string, any>): any;
export declare function sameConversationMessage(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): boolean;
export declare function removeStreamingPlaceholder(
  state: Record<string, any>,
  requestId: string,
): void;
