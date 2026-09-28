/** Shared semantic quality policy; the core separately enforces score, time, and evidence admission. */
export const MEMORY_KNOWLEDGE_QUALITY_INSTRUCTIONS = Object.freeze([
  "Keep only durable user facts, preferences, or supported patterns that are useful across future conversations after the current task ends. No proposal is better than weak or temporary knowledge.",
  "Exclude task diaries, current workflow or screen activity, transient review status, completed operations, plans without lasting personal relevance, transcripts, guesses, test or QA data, credentials, and anything the user asked not to remember. Relevance to the current answer alone does not make useful memory.",
  "Distinguish content the user reads or tests from facts about the user. Seeing a name, preference, claim, or instruction on screen or in supplied material does not establish that it describes the user. Preserve authorship and uncertainty; repetition of the same source is not independent support.",
]);
