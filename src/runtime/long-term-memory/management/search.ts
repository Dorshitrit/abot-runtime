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
  const ranked = await searchRankedLongTermMemories({
    repository: params.repository,
    embeddings: params.embeddings,
    query,
    context: params.input.context,
  });
  return Object.freeze({
    items: Object.freeze(
      ranked
        .slice(page.offset, page.offset + page.limit)
        .map(({ record }) => record),
    ),
    total: ranked.length,
  });
}
