const PRESENTATIONS = Object.freeze({
  execution_agent: Object.freeze({ title: "Execution Agent", responsibility: "Handles the request and tools" }),
  auditor: Object.freeze({ title: "Auditor", responsibility: "Audits the result" }),
});

/** Accept only recorded aliases of the same canonical role. */
export function recordedPresentationRole(role, value) {
  if (role === "supervisor" && value === "execution_agent") return value;
  if (role === "reviewer" && value === "auditor") return value;
  return undefined;
}

export function rolePresentation(role, value) {
  const recorded = recordedPresentationRole(role, value);
  return recorded ? PRESENTATIONS[recorded] : undefined;
}
