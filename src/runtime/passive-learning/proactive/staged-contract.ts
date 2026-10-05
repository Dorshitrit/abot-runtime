import { MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS } from "../review-progress.js";

export const PROACTIVE_MESSAGE_STAGE = "message.raw.v1";
export const PROACTIVE_PROPOSAL_STAGES = Object.freeze(["sources", "objective", PROACTIVE_MESSAGE_STAGE, "title", "handoff", "timing"]);
export const MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS = PROACTIVE_PROPOSAL_STAGES.length * MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS;
