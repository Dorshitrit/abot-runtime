import { environmentChangeWasDeclined } from "./environment-transition.js";

/** Discard configuration and schedule drafts only after both preparations remain current. */
export function prepareEnvironmentWorkspaceChanges(schedules, configuration) {
  const schedule = schedules.prepareEnvironmentChange();
  if (environmentChangeWasDeclined(schedule)) return null;
  const config = configuration.prepareDiscardChanges("change environment");
  if (environmentChangeWasDeclined(config)) return null;
  const commit = () => {
    if (typeof schedule === "function") schedule();
    if (typeof config === "function") config();
  };
  commit.canCommit = () => {
    if (schedule?.canCommit?.() === false) return false;
    return config?.canCommit?.() !== false;
  };
  return commit;
}
