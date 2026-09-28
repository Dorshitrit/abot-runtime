import {
  hasLocalMacSetup,
  hasMacSetup,
  macConnectionCommand,
  macRepairConnectionCommand,
  readMacPairingReceipt,
} from "./macos-setup.js";

export function createMacConnectionActions({
  state,
  connectLocal,
  createPairing,
  getRuntimeOrigin,
  canInstallOnPlatform,
  beginRequest,
  finishRequest,
  isCurrentResponse,
  getSurfaceRevision,
  isVisible,
  load,
}) {
  function canApplyMacResponse(operation, surface) {
    if (!isCurrentResponse(operation)) return false;
    if (surface !== getSurfaceRevision()) return false;
    return isVisible();
  }
  function macActionFailure(error) {
    if (typeof error?.message !== "string")
      return "Mac connection could not be completed. Try again.";
    return (
      error.message.trim().slice(0, 500) ||
      "Mac connection could not be completed. Try again."
    );
  }
  async function connectMac() {
    if (typeof connectLocal !== "function") return false;
    if (!canInstallOnPlatform("macos")) return false;
    if (!hasLocalMacSetup(state.snapshot)) return false;
    const operation = beginRequest();
    const surface = getSurfaceRevision();
    let connected = false;
    try {
      await connectLocal();
      if (!canApplyMacResponse(operation, surface)) return false;
      state.manualMac = null;
      state.downloaded = null;
      state.message = "Mac connection started. Checking readiness…";
      connected = true;
    } catch (error) {
      if (canApplyMacResponse(operation, surface))
        state.actionError = macActionFailure(error);
    } finally {
      finishRequest(operation);
    }
    if (!connected) return false;
    return load();
  }
  async function pairMac() {
    if (!canInstallOnPlatform("macos")) return false;
    if (!hasMacSetup(state.snapshot)) return false;
    if (hasLocalMacSetup(state.snapshot)) return false;
    const repair = state.snapshot.paired === true;
    if (!repair && typeof createPairing !== "function") return false;
    state.manualMac = null;
    const operation = beginRequest();
    const surface = getSurfaceRevision();
    try {
      const pairing = repair
        ? {}
        : readMacPairingReceipt(await createPairing());
      if (!canApplyMacResponse(operation, surface)) return false;
      const instructions = repair
        ? macRepairConnectionCommand()
        : macConnectionCommand(getRuntimeOrigin());
      state.manualMac = {
        ...instructions,
        ...pairing,
        repair,
      };
      state.downloaded = null;
      state.message = "";
      return true;
    } catch (error) {
      if (canApplyMacResponse(operation, surface))
        state.actionError = macActionFailure(error);
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  return { connectMac, pairMac };
}
