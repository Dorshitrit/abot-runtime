import type { ModelGatewayClient } from "../../ports.js";
import { readModelMessages } from "./semantic-compaction-model-fixture.js";

type SourceSlot = { sourceKey: string; sourceRef: string; digest?: string };
type ReplacementInput = {
  previousSourceDigests?: readonly SourceSlot[];
  previousCheckpoint?: { sourceDigests: readonly SourceSlot[] };
  partialSourceFold?: { sourceDigests: readonly SourceSlot[] };
  sourceSlice?: SourceSlot;
  newSources?: readonly SourceSlot[];
};

/** Mirrors the model's keyed rolling-output contract, without rewriting source identities. */
export function semanticCompactionReplacementSlots(
  value: unknown,
  newDigest: (sourceRef: string) => string,
): Readonly<Record<string, string>> {
  const envelope = value as ReplacementInput;
  const previous =
    envelope.partialSourceFold?.sourceDigests ??
    envelope.previousSourceDigests ??
    envelope.previousCheckpoint?.sourceDigests ??
    [];
  const current = envelope.sourceSlice
    ? [envelope.sourceSlice]
    : (envelope.newSources ?? []);
  return Object.fromEntries([
    ...previous.map(({ sourceKey, sourceRef, digest }) => [
      sourceKey,
      digest ?? newDigest(sourceRef),
    ]),
    ...current.map(({ sourceKey, sourceRef }) => [
      sourceKey,
      newDigest(sourceRef),
    ]),
  ]);
}

/** Generation admission and consumer checkpoint admission count different messages. */
export function withCheckpointTokenMeasurement(
  count: NonNullable<ModelGatewayClient["countInputTokens"]>,
): NonNullable<ModelGatewayClient["countInputTokens"]> {
  return async (input) => {
    const measured = await count(input);
    const isCheckpoint = isSemanticCheckpointMeasurement(input.messages);
    return isCheckpoint && measured
      ? { ...measured, inputTokens: 1000 }
      : measured;
  };
}

/** Only the isolated output-validation projection; full consumer inputs retain their own count. */
export function isSemanticCheckpointMeasurement(input: unknown): boolean {
  const messages = readModelMessages(input);
  if (messages.length !== 1 || messages[0]?.role !== "user") return false;
  try {
    return (
      JSON.parse(messages[0].content).kind ===
      "runtime_semantic_compaction_checkpoint_v2"
    );
  } catch {
    return false;
  }
}
