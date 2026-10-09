/** Passive descriptions of saved Studio output; not execution guarantees or binding defaults. */
export type ToolNormalInvocationOutputChannelRole = "content" | "metadata" | "conditional";
export type ToolNormalInvocationOutputChannels = Readonly<{
  text: ToolNormalInvocationOutputChannelRole;
  data: ToolNormalInvocationOutputChannelRole;
}>;

function isOutputChannelsRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOutputChannelKeys(value: Record<string, unknown>): boolean {
  if (Object.keys(value).length !== 2) return false;
  return Object.hasOwn(value, "text") && Object.hasOwn(value, "data");
}

function requireOutputChannelRole(value: unknown, path: string): ToolNormalInvocationOutputChannelRole {
  if (value === "content" || value === "metadata" || value === "conditional") return value;
  throw new Error(`${path} must be content, metadata, or conditional`);
}

/** Shared by manifest and normal-invocation validation; omission stays undeclared. */
export function parseOptionalToolOutputChannels(
  value: unknown,
  path: string,
): Readonly<{ outputChannels?: ToolNormalInvocationOutputChannels }> {
  if (value === undefined) return {};
  if (!isOutputChannelsRecord(value)) throw new Error(`${path} must be an object`);
  if (!hasExactOutputChannelKeys(value)) throw new Error(`${path} must contain only text and data`);
  return { outputChannels: Object.freeze({
    text: requireOutputChannelRole(value.text, `${path}.text`),
    data: requireOutputChannelRole(value.data, `${path}.data`),
  }) };
}
