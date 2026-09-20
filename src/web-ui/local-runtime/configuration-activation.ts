import type { LocalRuntimeApplication } from "../../runtime/local-application.js";
import type { RuntimeSetupActivation } from "./runtime-setup-input.js";
import type { RuntimeSetupGatewayRestorePoint } from "../runtime-setup-gateway.js";
import {
  closeIdleEnvironments,
  closeReplacementEnvironments,
  requireActivationIntakeOpen,
  settleExistingEnvironments,
  startReplacementEnvironments,
  type EnvironmentEntry,
  type IdleEnvironmentShutdown,
} from "./configuration-activation-environments.js";

type ActivationOptions = {
  environments: Map<string, LocalRuntimeApplication>;
  defaultEnvironmentId: string;
  environmentIds?: readonly string[];
  createEnvironment: (id: string) => LocalRuntimeApplication;
  recreateEnvironment: (
    id: string,
    previous: LocalRuntimeApplication,
  ) => LocalRuntimeApplication;
  createGatewayRestorePoint?: () => RuntimeSetupGatewayRestorePoint;
  onRestorationFailure?: () => void;
  prepareConfiguration?: () => void;
  restoreConfiguration?: () => void;
  checkGateway?: () => Promise<RuntimeSetupActivation>;
  activateGateway: () => Promise<RuntimeSetupActivation>;
  canContinue?: () => boolean;
};

function blockedActivation(message: string): RuntimeSetupActivation {
  return { status: "restart_required", message };
}

function ownerActivationBlock(
  current: readonly EnvironmentEntry[],
): RuntimeSetupActivation | undefined {
  const hasExternalOwner = current.some(
    ([, environment]) => environment.getOwnership() !== "owner",
  );
  if (hasExternalOwner) {
    return blockedActivation(
      "Another process owns this runtime. Changes are saved and will apply when that process restarts.",
    );
  }
  const hasBusyOwner = current.some(
    ([, environment]) => !environment.isOwnerIdle(),
  );
  if (hasBusyOwner) {
    return blockedActivation(
      "Your agent is working. Wait for active conversations and Jobs to finish, then apply again.",
    );
  }
  return undefined;
}

function desiredEnvironmentIds(options: ActivationOptions): string[] {
  const ids = new Set(options.environmentIds ?? options.environments.keys());
  if (ids.size === 0) ids.add(options.defaultEnvironmentId);
  return [...ids];
}

/** Idle admission is checked at the owning host, never from a browser activity list. */
export async function applyRuntimeConfiguration(
  options: ActivationOptions,
): Promise<RuntimeSetupActivation> {
  requireActivationIntakeOpen(options);
  const ids = desiredEnvironmentIds(options);
  const current = await settleExistingEnvironments(options);
  const initialBlock = ownerActivationBlock(current);
  if (initialBlock) return initialBlock;
  options.prepareConfiguration?.();
  const gatewayCheck = await options.checkGateway?.();
  requireActivationIntakeOpen(options);
  if (gatewayCheck?.status === "restart_required") return gatewayCheck;

  // Config parsing is synchronous and cannot alter owner intake.
  const replacements = ids.map(
    (id) => [id, options.createEnvironment(id)] as const,
  );
  const finalBlock = ownerActivationBlock(current);
  if (finalBlock) return finalBlock;
  const gatewayRestorePoint = options.createGatewayRestorePoint?.();
  const shutdown = await closeIdleEnvironments(options, current);
  if (shutdown.status === "failed") {
    await restoreAfterIdleShutdownFailure(options, shutdown);
    throw shutdown.error;
  }
  let activation: RuntimeSetupActivation;
  try {
    requireActivationIntakeOpen(options);
    activation = await options.activateGateway();
    requireActivationIntakeOpen(options);
    if (isRuntimeActivationReady(activation))
      await startReplacementEnvironments(options, replacements);
  } catch (error) {
    await restoreConfigurationAfterFailure(
      options,
      current,
      gatewayRestorePoint,
      error,
    );
    throw error;
  }
  if (!isRuntimeActivationReady(activation)) {
    await restoreConfigurationAfterFailure(
      options,
      current,
      gatewayRestorePoint,
      new Error(
        activation.message ?? "Runtime configuration was not activated.",
      ),
    );
  }
  return activation;
}

async function restoreAfterIdleShutdownFailure(
  options: ActivationOptions,
  shutdown: Extract<IdleEnvironmentShutdown, { status: "failed" }>,
): Promise<void> {
  if (isActivationStopped(options)) return;
  // A rejected close does not prove that the previous owner's lease was released.
  if (shutdown.hasUncertainOwners) options.onRestorationFailure?.();
  try {
    options.restoreConfiguration?.();
    const restored = shutdown.closed.map(
      ([id, environment]) =>
        [id, options.recreateEnvironment(id, environment)] as const,
    );
    await startReplacementEnvironments(options, restored);
  } catch (restorationError) {
    if (isActivationStopped(options)) return;
    options.onRestorationFailure?.();
    throw new AggregateError(
      [shutdown.error, restorationError],
      "Idle runtime shutdown failed and closed environments could not be restored.",
    );
  }
}

async function restoreConfigurationAfterFailure(
  options: ActivationOptions,
  previous: readonly EnvironmentEntry[],
  gateway: RuntimeSetupGatewayRestorePoint | undefined,
  activationError: unknown,
): Promise<void> {
  if (isActivationStopped(options)) return;
  try {
    await closeReplacementEnvironments(options, previous);
    if (isActivationStopped(options)) return;
    options.restoreConfiguration?.();
    await gateway?.restore();
    if (isActivationStopped(options)) return;
    const restored = previous.map(
      ([id, environment]) =>
        [id, options.recreateEnvironment(id, environment)] as const,
    );
    await startReplacementEnvironments(options, restored);
  } catch (restorationError) {
    if (isActivationStopped(options)) return;
    options.onRestorationFailure?.();
    throw new AggregateError(
      [activationError, restorationError],
      "Configuration activation failed and the previous runtime could not be restored.",
    );
  }
}

function isActivationStopped(options: ActivationOptions): boolean {
  return options.canContinue?.() === false;
}

function isRuntimeActivationReady(activation: RuntimeSetupActivation): boolean {
  return activation.status === "ready";
}
