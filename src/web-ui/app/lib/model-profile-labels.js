import { textOf } from "./text-format.js";

function profileLabel(profile) {
  return textOf(profile.label).trim() || textOf(profile.id);
}

/** Disambiguate saved choices without changing their identity or stored label. */
export function modelProfileLabels(profiles) {
  const counts = new Map();
  for (const profile of profiles) {
    const label = profileLabel(profile);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return new Map(profiles.map((profile) => {
    const label = profileLabel(profile);
    return [profile.id, counts.get(label) > 1 ? label + " · " + profile.id : label];
  }));
}
