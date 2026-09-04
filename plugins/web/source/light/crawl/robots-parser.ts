export type RobotsRule = Readonly<{ path: string; allow: boolean }>;
export type RobotsDocument = Readonly<{
  rules: readonly RobotsRule[];
  sitemaps: readonly string[];
}>;

type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

function normalizeRobotsPath(value: string): string {
  return value
    .replace(/[^\x00-\x7f]/gu, (character) => encodeURIComponent(character))
    .replace(/%[0-9a-f]{2}/giu, (escape) => {
      const character = String.fromCharCode(
        Number.parseInt(escape.slice(1), 16),
      );
      return /^[a-z0-9._~-]$/iu.test(character)
        ? character
        : escape.toUpperCase();
    });
}

export function parseRobotsDocument(
  text: string,
  productToken = "abot-runtime-web",
): RobotsDocument {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  let hasRules = false;
  for (const rawLine of text.replace(/^\uFEFF/u, "").split(/\r?\n|\r/u)) {
    const line = rawLine.split("#", 1)[0]!.trim();
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (name === "user-agent") {
      if (!current || hasRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasRules = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    const isAccessRule = name === "allow" || name === "disallow";
    if (!isAccessRule) continue;
    hasRules = true;
    if (!value.startsWith("/")) continue;
    current.rules.push({
      path: normalizeRobotsPath(value),
      allow: name === "allow",
    });
  }
  const matching = groups.filter((group) =>
    group.agents.includes(productToken.toLowerCase()),
  );
  const applicable =
    matching.length > 0
      ? matching
      : groups.filter((group) => group.agents.includes("*"));
  return Object.freeze({
    rules: Object.freeze(applicable.flatMap((group) => group.rules)),
    sitemaps: Object.freeze([...new Set(sitemaps)]),
  });
}

// A bounded wildcard matcher avoids regular-expression backtracking on robots input.
function matchesRobotsPath(
  path: string,
  pattern: string,
  work: { remaining: number },
): boolean | undefined {
  const anchored = pattern.endsWith("$");
  const candidate = anchored ? pattern.slice(0, -1) : pattern;
  let pathIndex = 0;
  let patternIndex = 0;
  let wildcardIndex = -1;
  let wildcardEnd = 0;
  while (pathIndex < path.length) {
    work.remaining -= 1;
    if (work.remaining < 0) return undefined;
    if (patternIndex === candidate.length && !anchored) return true;
    if (candidate[patternIndex] === "*") {
      wildcardIndex = patternIndex++;
      wildcardEnd = pathIndex;
      continue;
    }
    if (candidate[patternIndex] === path[pathIndex]) {
      pathIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (wildcardIndex < 0) return false;
    patternIndex = wildcardIndex + 1;
    pathIndex = ++wildcardEnd;
  }
  while (candidate[patternIndex] === "*") patternIndex += 1;
  return patternIndex === candidate.length;
}

function ruleSpecificity(path: string): number {
  return path.length;
}

export function isRobotsPathAllowed(
  document: RobotsDocument,
  url: URL,
): boolean {
  if (url.pathname === "/robots.txt") return true;
  const path = normalizeRobotsPath(url.pathname + url.search)
    .replace(/\*/gu, "%2A")
    .replace(/\$/gu, "%24");
  const work = { remaining: 2_000_000 };
  let longestMatch = -1;
  let allowed = true;
  for (const rule of document.rules) {
    const matches = matchesRobotsPath(path, rule.path, work);
    if (matches === undefined) return false;
    if (!matches) continue;
    const specificity = ruleSpecificity(rule.path);
    if (specificity < longestMatch) continue;
    if (specificity === longestMatch && !rule.allow) continue;
    longestMatch = specificity;
    allowed = rule.allow;
  }
  return allowed;
}
