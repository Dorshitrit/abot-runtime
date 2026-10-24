import { createEmbeddingCredentialStatus } from "../runtime-setup/embedding-credential-status.js";
import { createMemoryEmbeddingConnectionDialog } from "./embedding-connection-dialog.js";

export function createMemoryEmbeddingConnectionFeature({
  root,
  runtimeClient,
  getEnvironmentId,
  getWorkspace,
  canOpen = () => true,
  refreshMemory = async () => true,
  onSaved,
  onApplied,
  onClosed,
}) {
  let dialog;

  function credentials(environmentId, memoryOptions = {}) {
    return createEmbeddingCredentialStatus({
      getEnvironmentId: () => environmentId,
      runtimeClient: {
        loadLongTermMemoryStatus: (id) => runtimeClient.loadLongTermMemoryStatus(id),
        loadModelSetup: (id) => runtimeClient.loadModelSetup(id),
        saveRuntimeSetupEmbedding: async (input, id) => {
          const request = { ...input, ...memoryOptions };
          try {
            return await runtimeClient.saveMemoryEmbeddingConnection(request, id);
          } finally {
            delete request.apiKey;
          }
        },
      },
    });
  }

  function createDialog() {
    return createMemoryEmbeddingConnectionDialog({
      root,
      getEnvironmentId,
      loadStatus: (environmentId) => credentials(environmentId).loadStatus(),
      saveConnection: (input, memoryOptions, environmentId) =>
        credentials(environmentId, memoryOptions).saveEmbedding(input),
      discoverModels: (providerId, environmentId) =>
        runtimeClient.discoverLongTermMemoryModels({ providerId, environmentId }),
      beginRuntimeMutation: () =>
        getWorkspace().beginExternalRuntimeMutation("embedding connection"),
      endRuntimeMutation: () => getWorkspace().endExternalRuntimeMutation(),
      refreshRuntimeConfig: async (environmentId) => {
        const refreshed = await getWorkspace().refreshAfterExternalRuntimeMutation(
          "Embedding connection saved; refresh required",
        );
        if (environmentId !== getEnvironmentId()) return false;
        const memoryRefreshed = await refreshMemory();
        return refreshed && memoryRefreshed;
      },
      applyConfiguration: (environmentId) =>
        runtimeClient.applyRuntimeConfiguration(environmentId),
      onSaved,
      onApplied,
      onClosed,
    });
  }

  return {
    async open(options) {
      if (!canOpen() || dialog?.isOpen()) return false;
      const workspace = getWorkspace();
      if (!workspace.beginExternalRuntimeMutation("embedding connection")) return false;
      workspace.endExternalRuntimeMutation();
      dialog ??= createDialog();
      return dialog.open(options);
    },
    isOpen: () => dialog?.isOpen() === true,
    environmentChanged: () => dialog?.environmentChanged(),
  };
}
