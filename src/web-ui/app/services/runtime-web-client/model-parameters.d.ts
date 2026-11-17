import type { ConfigModelParameterPresentation } from "../../../config-dashboard-contracts.js";
export type ModelParameterRequests = {
  previewModelParameters(candidate: Record<string, unknown>, environmentId?: string): Promise<{
    ok: true;
    presentation: ConfigModelParameterPresentation;
  }>;
};
