import {
  parseSetupEmbeddingInput,
  type SetupEmbeddingInput,
} from "./setup-embedding-input.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import { readEmbeddingProfileId } from "../../runtime/long-term-memory/onboarding/embedding-profile-id.js";

export type MemoryEmbeddingConnectionInput = SetupEmbeddingInput &
  Readonly<{
    profileId?: string;
    emitClientEvents?: boolean;
  }>;

/** Settings keep their existing memory options while sharing provider validation. */
export function parseMemoryEmbeddingConnectionInput(
  body: Record<string, unknown>,
): MemoryEmbeddingConnectionInput {
  const { profileId, emitClientEvents, ...connection } = body;
  const hasUnsupportedProfileId =
    profileId !== undefined && typeof profileId !== "string";
  if (hasUnsupportedProfileId)
    throw new RuntimeSetupError(
      "invalid_embedding_profile",
      "Enter a valid embedding profile ID.",
    );
  const hasUnsupportedMemoryEvents =
    emitClientEvents !== undefined && typeof emitClientEvents !== "boolean";
  if (hasUnsupportedMemoryEvents)
    throw new RuntimeSetupError(
      "invalid_memory_events",
      "The memory events choice must be true or false.",
    );
  const input = parseSetupEmbeddingInput(connection);
  const requestedProfileId = profileId?.trim();
  return {
    ...input,
    ...(requestedProfileId
      ? { profileId: readEmbeddingProfileId(requestedProfileId) }
      : {}),
    ...(emitClientEvents === undefined ? {} : { emitClientEvents }),
  };
}
