import { environmentChangeWasDeclined } from "../../controllers/environment-transition.js";

/** No draft is discarded until both the existing workspace and native widgets accept leaving. */
export async function prepareSystemWidgetEnvironmentChange(existingPrepare, managementPrepare) {
  const existing = await existingPrepare();
  if (environmentChangeWasDeclined(existing)) return null;
  const management = await managementPrepare();
  if (environmentChangeWasDeclined(management)) return null;
  const canCommit = () => existing?.canCommit?.() !== false && management?.canCommit?.() !== false;
  if (!canCommit()) return null;
  const commit = () => {
    if (!canCommit()) return false;
    for (const preparation of [existing, management]) {
      if (typeof preparation === "function" && preparation() === false) return false;
    }
    return true;
  };
  commit.canCommit = canCommit;
  return commit;
}
