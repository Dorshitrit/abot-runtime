const EVENT_NAME = "user.interaction";
const MESSAGE_KIND = "user_interaction";
const MESSAGE_TEXT_MAX_LENGTH = 1_200;

export function isUserInteractionEvent(event) {
  return event?.type === "event" && event.name === EVENT_NAME;
}

export function isUserInteractionMessage(message) {
  return message?.kind === MESSAGE_KIND;
}

function hasInteractionIdentity(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteractionSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isInteractionOrigin(origin) {
  if (!origin || typeof origin !== "object") return false;
  if (!hasInteractionIdentity(origin.callId)) return false;
  if (!isInteractionSequence(origin.activationCount)) return false;
  return Number.isSafeInteger(origin.steeringVersion) && origin.steeringVersion >= 0;
}

function isInteractionMessageText(value) {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return value.length <= MESSAGE_TEXT_MAX_LENGTH;
}

function isInteractionTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString() === value;
}

/** Only the supported versioned presentation is projected into the conversation. */
export function projectUserInteractionEvent(event) {
  if (!isUserInteractionEvent(event)) return null;
  const interaction = event.interaction;
  if (!interaction || interaction.version !== 1 || interaction.kind !== "message") return null;
  if (!hasInteractionIdentity(event.requestId)) return null;
  if (interaction.requestId !== event.requestId) return null;
  if (!hasInteractionIdentity(interaction.interactionId)) return null;
  if (!isInteractionSequence(interaction.sequence)) return null;
  if (!isInteractionTimestamp(interaction.createdAt)) return null;
  if (!isInteractionOrigin(interaction.origin)) return null;
  if (!isInteractionMessageText(interaction.payload?.text)) return null;
  if (event.generation !== undefined && !hasInteractionIdentity(event.generation)) return null;
  const generation = event.generation || "";
  return {
    id: JSON.stringify(["user-interaction", event.requestId, generation, interaction.interactionId]),
    kind: MESSAGE_KIND,
    role: "assistant",
    requestId: event.requestId,
    text: interaction.payload.text,
    createdAt: interaction.createdAt,
    streaming: false,
    interactionId: interaction.interactionId,
    interactionSequence: interaction.sequence,
    interactionGeneration: generation,
    interactionOrigin: {
      callId: interaction.origin.callId,
      activationCount: interaction.origin.activationCount,
      steeringVersion: interaction.origin.steeringVersion,
    },
    ...(isInteractionSequence(event.eventSequence) ? { eventSequence: event.eventSequence } : {}),
    ...(isInteractionSequence(event.seqNo) ? { seqNo: event.seqNo } : {}),
  };
}
