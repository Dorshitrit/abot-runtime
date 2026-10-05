import {
  validateJsonSchemaValue,
  type JsonSchemaValueValidationIssue,
} from "../../model/json-schema-value.js";
import type { WorkerCapabilityPayloadResponseFormat } from "./payload-contracts.js";

type PayloadBodyNormalization =
  | Readonly<{ ok: true; body: string }>
  | Readonly<{ ok: false; issue: JsonSchemaValueValidationIssue }>;

/** Normalizes declared JSON payloads without discarding repeated members. */
export function normalizePayloadBody(
  body: string,
  responseFormat: WorkerCapabilityPayloadResponseFormat | undefined,
): PayloadBodyNormalization {
  if (!responseFormat) return Object.freeze({ ok: true, body });
  try {
    if (hasDuplicateJsonObjectMembers(body)) {
      return invalidPayloadJson(
        "JSON object member names must be unique within each object.",
      );
    }
    const parsed: unknown = JSON.parse(body);
    const issue = responseFormat === "json"
      ? undefined
      : validateJsonSchemaValue(responseFormat, parsed);
    if (issue) return Object.freeze({ ok: false, issue });
    return Object.freeze({ ok: true, body: JSON.stringify(parsed) });
  } catch {
    return invalidPayloadJson(
      "Return one valid JSON value matching the frozen response format.",
    );
  }
}

function invalidPayloadJson(message: string): PayloadBodyNormalization {
  return Object.freeze({
    ok: false,
    issue: Object.freeze({ path: "output", message }),
  });
}

/** Only checks member identity; JSON.parse remains the syntax/value decoder. */
function hasDuplicateJsonObjectMembers(body: string): boolean {
  const containers: (Set<string> | undefined)[] = [];
  for (let offset = 0; offset < body.length; offset += 1) {
    const token = body[offset];
    if (token === "{") {
      containers.push(new Set());
      continue;
    }
    if (token === "[") {
      containers.push(undefined);
      continue;
    }
    if (token === "}" || token === "]") {
      containers.pop();
      continue;
    }
    if (token !== '"') continue;
    const start = offset;
    const end = jsonStringEnd(body, start);
    offset = end;
    const members = containers.at(-1);
    if (!isJsonObjectMember(body, end, members)) continue;
    const member: string = JSON.parse(body.slice(start, end + 1));
    if (members.has(member)) return true;
    members.add(member);
  }
  return false;
}

function isJsonObjectMember(
  body: string,
  stringEnd: number,
  members: Set<string> | undefined,
): members is Set<string> {
  if (!members) return false;
  let next = stringEnd + 1;
  while (/[ \t\r\n]/u.test(body[next] ?? "")) next += 1;
  return body[next] === ":";
}

function jsonStringEnd(body: string, start: number): number {
  let offset = start + 1;
  while (offset < body.length) {
    if (body[offset] === "\\") {
      offset += 2;
      continue;
    }
    if (body[offset] === '"') return offset;
    offset += 1;
  }
  throw new SyntaxError("Unterminated JSON string.");
}
