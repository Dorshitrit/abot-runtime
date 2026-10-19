import { environmentChangeWasDeclined } from "./environment-transition.js";

/** Discard workspace drafts only after every preparation remains current. */
export function prepareEnvironmentWorkspaceChanges(schedules, configuration, skills) {
  const schedule = schedules.prepareEnvironmentChange();
  if (environmentChangeWasDeclined(schedule)) return null;
  const config = configuration.prepareDiscardChanges("change environment");
  if (environmentChangeWasDeclined(config)) return null;
  const skill = skills ? skills.prepareEnvironmentChange() : true;
  if (environmentChangeWasDeclined(skill)) return null;
  const commit = () => {
    if (typeof skill === "function") skill();
    if (typeof schedule === "function") schedule();
    if (typeof config === "function") config();
  };
  commit.canCommit = () => {
    if (skill?.canCommit?.() === false) return false;
    if (schedule?.canCommit?.() === false) return false;
    return config?.canCommit?.() !== false;
  };
  return commit;
}
