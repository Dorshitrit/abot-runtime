import { isRoleCapabilityId } from "../orchestration/role-calls/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityAdapterProvider,
  WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { createRegisteredToolNormalInvocationExecutor } from "./registered-tool-normal-invocations.js";
import {
  traceRegisteredToolWorkerCapabilityCatalogResolutionCompleted,
  traceRegisteredToolWorkerCapabilityCatalogResolutionRejected,
  traceRegisteredToolWorkerCapabilityCatalogResolutionStarted,
  traceRegisteredToolWorkerCapabilityGuidanceCompleted,
  traceRegisteredToolWorkerCapabilityGuidanceFailed,
  traceRegisteredToolWorkerCapabilityGuidanceStarted,
  traceRegisteredToolWorkerCapabilityResolutionCompleted,
  traceRegisteredToolWorkerCapabilityResolutionRejected,
  traceRegisteredToolWorkerCapabilityResolutionStarted,
  type RegisteredToolWorkerCapabilityProviderDiagnostic,
} from "./registered-tool-worker-capability-diagnostics.js";
import {
  narrowRegistrations,
  prepareSharedState,
  resolveRegisteredToolCapabilityCatalog,
} from "./registered-tool-worker-capabilities/catalog.js";
import type {
  RegisteredToolWorkerCapabilityProviderParams,
  ResolvedCapabilityCatalog,
} from "./registered-tool-worker-capabilities/contracts.js";
import {
  RegisteredToolWorkerCapabilityCompositionError,
  normalizeResolutionError,
} from "./registered-tool-worker-capabilities/errors.js";
import { projectWorkerAdapters } from "./registered-tool-worker-capabilities/execution.js";

export type { RegisteredToolWorkerCapabilityProviderParams } from "./registered-tool-worker-capabilities/contracts.js";

/**
 * Lazily projects a closed request ToolRegistry snapshot into neutral Worker
 * adapters. It contains no profile or request-routing policy.
 */
export function createRegisteredToolWorkerCapabilityProvider<TContext>(
  params: RegisteredToolWorkerCapabilityProviderParams,
): WorkerCapabilityAdapterProvider<TContext> {
  let diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic =
    Object.freeze({
      requestId: params.requestId,
      operationIds: Object.freeze([]),
    });
  let catalog: ResolvedCapabilityCatalog | undefined;
  let catalogFailure: Error | undefined;
  let catalogFailureCause: unknown;
  let adapters: readonly WorkerCapabilityAdapter<TContext>[] | undefined;
  let adapterFailure: Error | undefined;

  function resolveCatalog(): ResolvedCapabilityCatalog {
    if (catalog) return catalog;
    if (catalogFailure) throw catalogFailure;

    traceRegisteredToolWorkerCapabilityCatalogResolutionStarted(diagnostic);
    try {
      const registry = params.getRequestToolRegistry();
      catalog = resolveRegisteredToolCapabilityCatalog(
        registry,
        params.payloadAuthor !== undefined,
      );
      diagnostic = Object.freeze({
        requestId: params.requestId,
        operationIds: catalog.operationIds,
      });
      traceRegisteredToolWorkerCapabilityCatalogResolutionCompleted(
        diagnostic,
        catalog.descriptors.length,
      );
      return catalog;
    } catch (error: unknown) {
      catalogFailureCause = error;
      catalogFailure = normalizeResolutionError(error);
      traceRegisteredToolWorkerCapabilityCatalogResolutionRejected(diagnostic, {
        issueCode:
          catalogFailure instanceof
          RegisteredToolWorkerCapabilityCompositionError
            ? catalogFailure.issueCode
            : "resolution_failed",
        ...(catalogFailure instanceof
          RegisteredToolWorkerCapabilityCompositionError &&
        catalogFailure.operationId &&
        isRoleCapabilityId(catalogFailure.operationId)
          ? { operationId: catalogFailure.operationId }
          : {}),
        error,
      });
      throw catalogFailure;
    }
  }

  return Object.freeze({
    getDescriptors(): readonly WorkerCapabilityDescriptor[] {
      return resolveCatalog().descriptors;
    },
    async getExecutionGuidance(capabilityId: string): Promise<string> {
      if (!isRoleCapabilityId(capabilityId)) {
        throw new RegisteredToolWorkerCapabilityCompositionError(
          "guidance_capability_id_invalid",
        );
      }
      const selected = resolveCatalog().selected.find(
        ({ operation }) => operation.operationId === capabilityId,
      );
      if (!selected) {
        throw new RegisteredToolWorkerCapabilityCompositionError(
          "guidance_capability_unavailable",
          capabilityId,
        );
      }
      const toolName = selected.registration.toolName;
      traceRegisteredToolWorkerCapabilityGuidanceStarted(
        diagnostic,
        capabilityId,
        toolName,
      );
      if (!params.loadActionSkillContext) {
        traceRegisteredToolWorkerCapabilityGuidanceCompleted(
          diagnostic,
          capabilityId,
          toolName,
          0,
        );
        return "";
      }
      try {
        const context = await params.loadActionSkillContext(toolName);
        const normalized = typeof context === "string" ? context.trim() : "";
        traceRegisteredToolWorkerCapabilityGuidanceCompleted(
          diagnostic,
          capabilityId,
          toolName,
          normalized.length,
        );
        return normalized;
      } catch (error: unknown) {
        traceRegisteredToolWorkerCapabilityGuidanceFailed(
          diagnostic,
          capabilityId,
          toolName,
          error,
        );
        throw error;
      }
    },
    getAdapters(): readonly WorkerCapabilityAdapter<TContext>[] {
      if (adapters) return adapters;
      if (adapterFailure) throw adapterFailure;

      traceRegisteredToolWorkerCapabilityResolutionStarted(diagnostic);
      try {
        const resolvedCatalog = resolveCatalog();
        if (resolvedCatalog.selected.length === 0) {
          adapters = Object.freeze([]);
          traceRegisteredToolWorkerCapabilityResolutionCompleted(diagnostic, 0);
          return adapters;
        }
        const narrowedRegistrations = narrowRegistrations(
          resolvedCatalog.selected,
        );
        const sharedState = prepareSharedState(
          resolvedCatalog.registry,
          params.sessionId,
          params.requestContext,
        );
        const executor = createRegisteredToolNormalInvocationExecutor({
          registrations: narrowedRegistrations,
          toolRegistry: resolvedCatalog.registry,
          requestId: params.requestId,
          abortSignal: params.abortSignal,
          sharedState,
          toolPermissionMode: params.toolPermissionMode,
          ...(params.toolApprovalController
            ? { toolApprovalController: params.toolApprovalController }
            : {}),
          nextApprovalId: params.nextApprovalId,
          ...(params.onEvent ? { onEvent: params.onEvent } : {}),
        });
        adapters = projectWorkerAdapters<TContext>({
          operationIds: resolvedCatalog.operationIds,
          descriptors: resolvedCatalog.descriptors,
          executor,
          sharedState,
          diagnostic,
          ...(params.payloadAuthor
            ? { payloadAuthor: params.payloadAuthor }
            : {}),
        });
        traceRegisteredToolWorkerCapabilityResolutionCompleted(
          diagnostic,
          adapters.length,
        );
        return adapters;
      } catch (error: unknown) {
        adapterFailure = normalizeResolutionError(error);
        traceRegisteredToolWorkerCapabilityResolutionRejected(diagnostic, {
          issueCode:
            adapterFailure instanceof
            RegisteredToolWorkerCapabilityCompositionError
              ? adapterFailure.issueCode
              : "resolution_failed",
          ...(adapterFailure instanceof
            RegisteredToolWorkerCapabilityCompositionError &&
          adapterFailure.operationId &&
          isRoleCapabilityId(adapterFailure.operationId)
            ? { operationId: adapterFailure.operationId }
            : {}),
          error:
            error === catalogFailure && catalogFailureCause !== undefined
              ? catalogFailureCause
              : error,
        });
        throw adapterFailure;
      }
    },
  });
}
