const templates = [
  {
    id: "briefing",
    title: "Morning briefing",
    description: "A concise roundup of the day's important news.",
    timingLabel: "Daily · 08:00",
    schedule: { kind: "daily", at: "08:00" },
    prompt: "Find the five most significant world news developments from the past 24 hours. Give each a short headline, a two-sentence factual summary, and a link to a reliable source. Keep the briefing under 400 words.",
  },
  {
    id: "learning",
    title: "Learn something new",
    description: "One useful idea, with an example to make it stick.",
    timingLabel: "Weekdays · 12:00",
    schedule: { kind: "weekly", at: "12:00", weekdays: [1, 2, 3, 4, 5] },
    prompt: "Teach me one useful idea from science, history, technology, or everyday life in under 250 words. Explain it in plain language, give one concrete example, and finish with a question I can think about.",
  },
  {
    id: "reflection",
    title: "Weekly reflection",
    description: "Pause, reflect, and choose a priority for next week.",
    timingLabel: "Sunday · 18:00",
    schedule: { kind: "weekly", at: "18:00", weekdays: [0] },
    prompt: "Create a short weekly reflection exercise: three questions about what went well, what was difficult, and what to change next week. Finish with a simple template for choosing one priority. Do not assume anything about my work or personal circumstances.",
  },
];

export function getDashboardJobTemplates() {
  return structuredClone(templates);
}

export function dashboardJobInitialValues(templateId, modelProfileId) {
  const template = templates.find((item) => item.id === templateId);
  return {
    ...(template ? structuredClone(template) : {}),
    newConversation: true,
    modelProfileId,
    agentMode: "reasoning",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
