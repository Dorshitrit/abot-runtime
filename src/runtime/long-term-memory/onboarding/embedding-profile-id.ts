import { DEFAULT_MEMORY_EMBEDDING_PROFILE_ID } from "./configuration.js";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function readEmbeddingProfileId(value: string | undefined): string {
  const profileId = value?.trim() || DEFAULT_MEMORY_EMBEDDING_PROFILE_ID;
  if (!PROFILE_ID_PATTERN.test(profileId))
    throw new Error("long_term_memory_embedding_profile_id_invalid");
  return profileId;
}
