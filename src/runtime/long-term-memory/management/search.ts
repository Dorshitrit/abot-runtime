import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
} from "../contracts.js";
import { searchRankedLongTermMemories } from "../ranked-search.js";
import type { MemorySearchInput, MemorySearchResult } from "./contracts.js";
import { normalizeMemoryPage, normalizeSearchQuery } from "./validation.js";

export async function searchManagedMemories(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  input: MemorySearchInput;
}): Promise<MemorySearchResult> {
  const query = normalizeSearchQuery(params.input.query);
  const page = normalizeMemoryPage(params.input);
  const results = await searchRankedLongTermMemories({
    repository: params.repository,
    embeddings: params.embeddings,
    query,
    context: params.input.context,
  });
  const ranked =
    params.input.origin === "passive_observation"
      ? results.filter(
          ({ record }) =>
            record.provenance.kind === "passive_observation" ||
            (record.observationSources?.length ?? 0) > 0,
        )
      : results;
  return Object.freeze({
    items: Object.freeze(
      ranked
        .slice(page.offset, page.offset + page.limit)
        .map(({ record }) => record),
    ),
    total: ranked.length,
  });
}
