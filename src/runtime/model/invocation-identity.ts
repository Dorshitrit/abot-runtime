/** An activation scope prevents event identity reuse after a saved approval wait. */
export function createModelInvocationIdentity(
  requestId: string,
  scope: string | undefined,
  modelStep: string,
  sequence: number,
): string {
  if (scope === undefined) return `${requestId}:${modelStep}:${sequence}`;
  return `${requestId}:${scope}:${modelStep}:${sequence}`;
}
