import { environmentChangeWasDeclined } from "./environment-transition.js";

/** Discard workspace drafts only after every preparation remains current. */
export async function prepareEnvironmentWorkspaceChanges(schedules, configuration, skills) {
  const schedule = await schedules.prepareEnvironmentChange();
  if (environmentChangeWasDeclined(schedule)) return null;
  const config = await configuration.prepareDiscardChanges("change environment");
  if (environmentChangeWasDeclined(config)) return null;
  const skill = skills ? await skills.prepareEnvironmentChange() : true;
  if (environmentChangeWasDeclined(skill)) return null;
  const commit = () => {
    if (!commit.canCommit()) return false;
    for (const prepared of [skill, schedule, config]) {
      if (typeof prepared === "function" && prepared() === false) return false;
    }
    return true;
  };
  commit.canCommit = () => {
    if (skill?.canCommit?.() === false) return false;
    if (schedule?.canCommit?.() === false) return false;
    return config?.canCommit?.() !== false;
  };
  return commit;
}
