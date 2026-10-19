const ACTION_TITLES = Object.freeze({
  list_skills: "List skills",
  read_skill: "Read skill",
  read_skills: "Read skills",
  create_skill: "Create skill",
  update_skill: "Edit skill",
});

function boundedSkillText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function isSkillReadAction(action) {
  return action === "read_skill" || action === "read_skills";
}

function hasSuccessfulSkillResult(action, completed, ok) {
  if (action === "list_skills" || !Object.hasOwn(ACTION_TITLES, action)) return false;
  if (!completed) return false;
  return ok === true;
}

/** Decode declared display metadata only; never inspect a Skill body or tool output. */
export function skillActivityFields(meta, tool, completed, ok) {
  if (tool !== "abot_skills") return null;
  const action = boundedSkillText(meta.skillAction, 128);
  const activityTitle = Object.hasOwn(ACTION_TITLES, action)
    ? ACTION_TITLES[action]
    : "";
  const sent = [];
  if (activityTitle) sent.push({ label: "Action", value: activityTitle });
  if (action === "list_skills" || !activityTitle) return { activityTitle, target: "", sent };

  const readAction = isSkillReadAction(action);
  const referenceLimit = readAction ? 160 : 128;
  const referenceLabel = readAction ? "Skill reference" : "Skill ID";
  const skillId = action === "read_skills"
    ? boundedSkillText(Array.isArray(meta.skillIds)
      ? meta.skillIds.slice(0, 8).map((id) => boundedSkillText(id, referenceLimit)).filter(Boolean).join(", ")
      : "", 160)
    : boundedSkillText(meta.skillId, referenceLimit) || (completed && ok === true ? boundedSkillText(meta.savedSkillId, 128) : "");
  const skillTitle = hasSuccessfulSkillResult(action, completed, ok)
    ? boundedSkillText(meta.skillTitle, 160)
    : "";
  if (skillId) sent.push({ label: action === "read_skills" ? "Skill references" : referenceLabel, value: skillId });
  return { activityTitle, target: skillTitle || boundedSkillText(meta.skillName, 160) || skillId, sent };
}
