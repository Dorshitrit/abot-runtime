import type {
  ModelParameterProfile,
  ModelParameterProfileCatalog,
  ModelParameterProfileDiagnostic,
} from "../../shared/model-parameters.js";

function matchesModelPattern(
  match: ModelParameterProfile["match"][number],
  model: string,
): boolean {
  if (match.kind === "exact") return model === match.pattern;
  if (match.kind === "regex") return new RegExp(match.pattern).test(model);
  const expression = match.pattern
    .split("")
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`).test(model);
}

function matchesModelProfile(
  profile: ModelParameterProfile,
  provider: string,
  model: string,
): boolean {
  return profile.match.some((match) => {
    if (match.provider !== undefined && match.provider !== provider)
      return false;
    return matchesModelPattern(match, model);
  });
}

export function matchModelParameterProfile(
  catalog: ModelParameterProfileCatalog | undefined,
  provider: string,
  model: string,
): {
  profile?: ModelParameterProfile;
  diagnostics: ModelParameterProfileDiagnostic[];
} {
  const matches =
    catalog?.profiles.filter((profile) =>
      matchesModelProfile(profile, provider, model),
    ) ?? [];
  if (matches.length === 0) return { diagnostics: [] };
  const highestPriority = Math.max(
    ...matches.map((profile) => profile.priority ?? 0),
  );
  const winners = matches.filter(
    (profile) => (profile.priority ?? 0) === highestPriority,
  );
  if (winners.length === 1) return { profile: winners[0], diagnostics: [] };
  return {
    diagnostics: [
      {
        code: "ambiguous_parameter_profile",
        message: `Equal-priority parameter profiles match this model: ${winners
          .map((profile) => profile.id)
          .sort()
          .join(", ")}. No recommendations were applied.`,
      },
    ],
  };
}
