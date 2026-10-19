import { SKILL_CREATOR } from "./builtins/skill-creator.js";
import { ABOT_STUDIO_SKILL } from "./builtins/abot-studio.js";
import { COMPUTER_USE_SKILL } from "./builtins/computer-use.js";
import { TECHNICAL_WORK_SKILL } from "./builtins/technical-work.js";
import { createKnowledgeSkillStore } from "./store.js";

/** Packaged read-only documents; independent of installed or enabled plugins. */
export const builtinKnowledgeSkillStore = createKnowledgeSkillStore([
  ABOT_STUDIO_SKILL,
  COMPUTER_USE_SKILL,
  SKILL_CREATOR,
  TECHNICAL_WORK_SKILL,
]);
