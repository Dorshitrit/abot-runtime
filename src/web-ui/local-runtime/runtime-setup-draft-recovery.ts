import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import {
  isCurrentRuntimeSetupDraft,
  readRuntimeSetupDraft,
  type RuntimeSetupDraft,
} from "./runtime-setup-draft.js";
import { MalformedRuntimeSetupReceiptError } from "./runtime-setup-receipt-file.js";

export async function inspectRuntimeSetupDraftForSave(
  source: InspectedRuntimeConfigFile,
): Promise<{
  draft?: RuntimeSetupDraft;
  recoveryDraft?: RuntimeSetupDraft;
  recoveringDraft: boolean;
}> {
  let draft: RuntimeSetupDraft | undefined;
  try {
    draft = await readRuntimeSetupDraft(source.path);
  } catch (error) {
    if (!(error instanceof MalformedRuntimeSetupReceiptError)) throw error;
    return { recoveringDraft: true };
  }
  if (!draft) return { recoveringDraft: false };
  if (await isCurrentRuntimeSetupDraft(source, draft))
    return { draft, recoveringDraft: false };
  return { recoveryDraft: draft, recoveringDraft: true };
}
