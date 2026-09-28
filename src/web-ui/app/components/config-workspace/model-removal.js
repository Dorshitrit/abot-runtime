function isDefinitiveModelRemovalRejection(error) {
  const status = error?.status;
  if (!Number.isInteger(status)) return false;
  if (status < 400 || status >= 500) return false;
  return typeof error.payload?.error === "string";
}

function modelIsStillRegistered(payload, profileId) {
  const profiles = payload?.dashboard?.files?.runtime?.config?.models?.profiles;
  if (!profiles || typeof profiles !== "object")
    throw new Error("The Runtime model declarations could not be read.");
  if (Array.isArray(profiles))
    throw new Error("The Runtime model declarations could not be read.");
  return Object.hasOwn(profiles, profileId);
}

/** Declaration removal shares Configuration's dirty-state and mutation guards. */
export function createModelRemovalController({
  removeModel,
  loadDashboard,
  getEnvironmentId,
  beginRuntimeMutation,
  endRuntimeMutation,
  refreshRuntimeConfig,
  onSaved,
  setStatus,
  confirmRemoval = (message) => window.confirm(message),
}) {
  let pending = false;

  async function finishConfirmedRemoval(environmentId) {
    try {
      if (environmentId !== getEnvironmentId()) {
        setStatus(
          "Model removed in the previous environment. Reopen it to apply the saved change.",
        );
        return true;
      }
      onSaved();
      const refreshed = await refreshRuntimeConfig(
        "Model removed; refresh required",
      );
      if (refreshed)
        setStatus("Model removed. Apply changes when your agent is idle.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Model removed; refresh required: ${message}`, "error-text");
    }
    return true;
  }

  async function reconcileUncertainRemoval(profileId, environmentId, error) {
    let stillRegistered;
    try {
      stillRegistered = modelIsStillRegistered(
        await loadDashboard(environmentId),
        profileId,
      );
    } catch {
      setStatus(
        "Model removal could not be confirmed. Refresh Configuration before trying again.",
        "error-text",
      );
      return false;
    }
    if (!stillRegistered) return finishConfirmedRemoval(environmentId);
    setStatus(
      error instanceof Error ? error.message : String(error),
      "error-text",
    );
    return false;
  }

  async function remove({ profileId, label, expectedRevision }) {
    if (pending) return false;
    if (!beginRuntimeMutation("model removal")) return false;
    const environmentId = getEnvironmentId();
    pending = true;
    try {
      if (
        !confirmRemoval(
          `Remove ${label || profileId} from configured models? Its model file, provider and credentials will be kept.`,
        )
      )
        return false;
      try {
        await removeModel({ profileId, expectedRevision }, environmentId);
      } catch (error) {
        if (!isDefinitiveModelRemovalRejection(error))
          return await reconcileUncertainRemoval(profileId, environmentId, error);
        setStatus(
          error instanceof Error ? error.message : String(error),
          "error-text",
        );
        return false;
      }
      return await finishConfirmedRemoval(environmentId);
    } finally {
      pending = false;
      endRuntimeMutation();
    }
  }

  return { remove };
}
