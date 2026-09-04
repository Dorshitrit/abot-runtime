import { countTermMatches } from "../ranking/query-normalization.js";
import type { LightSource } from "./source-definition.js";

export function selectLightSources(
  queries: readonly string[],
  sources: readonly LightSource[],
  limit: number,
): readonly LightSource[] {
  const rankings = queries.map((query) => {
    const ranked = sources
      .map((source, index) => ({
        source,
        index,
        score: countTermMatches(
          query,
          `${source.title} ${source.description} ${source.keywords.join(" ")}`,
        ),
      }))
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      );
    const matching = ranked.filter(({ score }) => score > 0);
    if (matching.length > 0) return matching;
    return ranked;
  });
  const selected = new Map<string, LightSource>();
  for (let rank = 0; rank < sources.length; rank += 1) {
    for (const ranking of rankings) {
      if (selected.size >= limit) return Object.freeze([...selected.values()]);
      const item = ranking[rank];
      if (item) selected.set(item.source.id, item.source);
    }
  }
  return Object.freeze([...selected.values()]);
}
