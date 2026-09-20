/** Fence both runtime owners immediately, then always release the owned gateway. */
export async function closeRuntimeSetupServices(
  closeRuntime: () => Promise<void>,
  closeGateway: () => Promise<void>,
  closeHost?: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  const owners = closeHost ? [closeRuntime, closeHost] : [closeRuntime];
  const outcomes = await Promise.allSettled(
    owners.map(async (close) => close()),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") failures.push(outcome.reason);
  }
  try {
    await closeGateway();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Runtime services and model gateway shutdown failed.",
    );
}
