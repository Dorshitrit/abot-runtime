export const SUPERVISOR_HISTORY_INSTRUCTIONS = [
  "The exact current user request and its ordered active updates define the current work. Use earlier conversation to resolve references and recover relevant source facts and constraints; earlier requests do not themselves create pending work or renewed authorization.",
  "Use an earlier request or proposal as active work only when the current request calls for it; do not resume or repeat earlier actions merely because they appear in history.",
] as const;
