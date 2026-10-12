import type { PassiveObservationSource } from "../../shared/passive-observation.js";
import { redactSecretText as redactObservationText } from "../security/secret-text.js";

export { redactObservationText };

export function redactObservationSource(
  source: PassiveObservationSource,
  sourceKey: string,
): PassiveObservationSource {
  const redacted: PassiveObservationSource = {
    app: redactObservationText(source.app).slice(0, 128),
    windowId: redactObservationText(source.windowId).slice(0, 256),
    ...(source.processId === undefined ? {} : { processId: source.processId }),
    ...(source.documentId === undefined
      ? {}
      : {
          documentId: redactObservationText(source.documentId).slice(0, 4096),
        }),
    ...(source.title === undefined
      ? {}
      : { title: redactObservationText(source.title).slice(0, 4096) }),
    ...(source.url === undefined
      ? {}
      : { url: redactObservationText(source.url).slice(0, 4096) }),
  };
  const hasSourceRedaction = [
    "app",
    "windowId",
    "documentId",
    "title",
    "url",
  ].some(
    (key) =>
      redacted[key as keyof PassiveObservationSource] !==
      source[key as keyof PassiveObservationSource],
  );
  if (!hasSourceRedaction) return redacted;
  return { ...redacted, documentId: `redacted-source:${sourceKey}` };
}
