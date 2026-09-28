import type { PassiveObservationSource } from "../../shared/passive-observation.js";

const REDACTED = "[REDACTED]";
const CREDENTIAL_KEY_SOURCE = String.raw`(?:[A-Za-z][A-Za-z0-9_-]*\.)*(?:[A-Za-z][A-Za-z0-9]*[-_])*(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret[_ -]?access[_ -]?key|recovery[_ -]?code)`;
const credentialIndicator = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.-])(?:-{1,2})?(?:${CREDENTIAL_KEY_SOURCE}|(?:proxy-)?authorization)[\s"'\\]*[:=]`,
  "iu",
);

/** Detection only: normalize ASCII encodings once, without interpreting a language. */
function detectionText(input: string): string {
  const percentDecoded = input.replace(/%([0-7][0-9a-f])/giu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return percentDecoded.replace(
    /\\(?:u00|x|U000000)([0-7][0-9a-fA-F])/gu,
    (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function hasPrivateKeyIndicator(text: string): boolean {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u.test(text);
}

function hasUrlCredentials(text: string): boolean {
  return /\b[a-z][a-z0-9+.-]*(?::|%3a)(?:\/|%2f){2}[^\s/?#<>]*(?:@|%40)/iu.test(text);
}

function hasAuthorizationCredentials(text: string): boolean {
  for (const match of text.matchAll(
    /\b(Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]+={0,2})/giu,
  )) {
    if (match[1]!.toLowerCase() === "bearer") return true;
    const value = match[2]!;
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) continue;
    if (value.length < 8) continue;
    if (Buffer.from(value, "base64").toString("utf8").includes(":")) return true;
  }
  return false;
}

function isAwsAccessKeyValue(value: string, atEnd: boolean): boolean {
  if (/^[A-Z0-9]{16}$/u.test(value)) return true;
  if (!atEnd) return false;
  return /^[A-Z0-9]{4,15}$/u.test(value);
}

function isRecognizedProviderToken(
  prefix: string,
  value: string,
  atEnd: boolean,
): boolean {
  if (prefix === "AKIA" || prefix === "ASIA")
    return isAwsAccessKeyValue(value, atEnd);
  if (value.length >= 20) return true;
  const partialMinimum = prefix === "sk-" ? 8 : 1;
  return atEnd && value.length >= partialMinimum;
}

function hasProviderToken(text: string): boolean {
  const provider =
    /\b(sk-(?:proj-|svcacct-)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA)([A-Za-z0-9_-]+)/gu;
  for (const match of text.matchAll(provider)) {
    const atEnd = match.index + match[0].length === text.length;
    if (isRecognizedProviderToken(match[1]!, match[2]!, atEnd)) return true;
  }
  return false;
}

function compactJoseSegmentCount(header: string): number | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const fields = value as Record<string, unknown>;
    if (typeof fields.alg !== "string") return undefined;
    return typeof fields.enc === "string" ? 5 : 3;
  } catch {
    return undefined;
  }
}

function hasCompactJoseToken(text: string): boolean {
  const jose = /\b([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]*)+/gu;
  for (const match of text.matchAll(jose)) {
    const parts = match[0].split(".");
    const capturedAtEnd = match.index + match[0].length === text.length;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const expected = compactJoseSegmentCount(parts[index]!);
      if (expected === undefined) continue;
      if (expected === 3 && parts[index + 1] === "") continue;
      if (parts.length - index >= expected) return true;
      if (capturedAtEnd) return true;
    }
  }
  return false;
}

function hasSecretIndicator(text: string): boolean {
  if (credentialIndicator.test(text)) return true;
  if (hasPrivateKeyIndicator(text)) return true;
  if (hasUrlCredentials(text)) return true;
  if (hasAuthorizationCredentials(text)) return true;
  if (hasProviderToken(text)) return true;
  return hasCompactJoseToken(text);
}

/**
 * Mask the entire field when a known secret indicator is present, including
 * surrounding useful text. No value boundaries or source-language grammar are
 * inferred. Unlabelled arbitrary secrets and unknown encodings remain outside
 * detection; this is not a guarantee that unchanged text contains no secrets.
 */
export function redactObservationText(input: string): string {
  if (hasSecretIndicator(input)) return REDACTED;
  if (hasSecretIndicator(detectionText(input))) return REDACTED;
  return input;
}

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
