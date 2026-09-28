/** Leaves room for JSON-string escaping and result metadata in the SDK's 128 KiB envelope. */
export const COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES = 48 * 1024;

type Observation = Record<string, unknown>;
type ArrayField = "accessibility" | "windows";
type Collection = {
  observation: Observation;
  field: ArrayField;
  original: readonly unknown[];
};
const ARRAY_FIELDS: readonly ArrayField[] = ["accessibility", "windows"];
const ESSENTIAL_FIELDS = [
  "desktop_ref",
  "observation_ref",
  "platform",
  "displayTarget",
  "transport",
  "capturedAt",
  "imageWidth",
  "imageHeight",
  "coordinateSpace",
  "targetingGuarantee",
  "available",
  "imageAvailable",
  "evidenceScope",
  "requestedEffectVerified",
  "observationMeta",
] as const;

export function serializeComputerObservation(
  description: Observation,
  data: Observation,
): string {
  const observation = { ...description, ...data };
  return boundedOutput([observation], (items) => items[0]!);
}

export function serializeComputerDesktops(
  desktops: readonly Observation[],
): string {
  return boundedOutput(desktops, (items) => ({ desktops: items }));
}

function boundedOutput(
  observations: readonly Observation[],
  envelope: (items: Observation[]) => unknown,
): string {
  const projected = observations.map((observation) => ({ ...observation }));
  const serialize = () => JSON.stringify(envelope(projected));
  let output = serialize();
  if (fits(output)) return output;
  const collections: Collection[] = projected.flatMap((observation) =>
    ARRAY_FIELDS.flatMap((field) =>
      Array.isArray(observation[field])
        ? [
            {
              observation,
              field,
              original: observation[field] as readonly unknown[],
            },
          ]
        : [],
    ),
  );

  // Drop only suffixes. The remaining nodes retain their exact original order and values.
  for (const collection of collections) {
    setRetainedCount(collection, 0);
    output = serialize();
    if (!fits(output)) continue;
    let low = 0;
    let high = collection.original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setRetainedCount(collection, middle);
      if (fits(serialize())) low = middle;
      else high = middle - 1;
    }
    setRetainedCount(collection, low);
    return serialize();
  }

  // A malformed/oversized scalar base must not erase an accepted input receipt.
  // The explicit projection error replaces optional descriptive metadata, never pixels.
  const minimal = projected.map(minimalObservation);
  output = JSON.stringify(envelope(minimal));
  if (fits(output)) return output;
  throw new Error("computer_observation_identity_exceeds_output_budget");
}

function setRetainedCount(collection: Collection, count: number): void {
  const { observation, field, original } = collection;
  observation[field] = original.slice(0, count);
  const omittedCount = original.length - count;
  if (omittedCount === 0) return;
  const coverage = record(observation.outputCoverage) ?? {};
  observation.outputCoverage = {
    ...coverage,
    kind: "computer_output_coverage_v1",
    reason: "output_byte_limit",
    [field]: { retainedCount: count, omittedCount },
  };
  observation[`${field}Truncated`] = true;
}

function minimalObservation(observation: Observation): Observation {
  const output: Observation = {};
  for (const field of ESSENTIAL_FIELDS) {
    if (observation[field] !== undefined) output[field] = observation[field];
  }
  const dispatch = record(observation.dispatch);
  if (dispatch) {
    output.dispatch = {
      status: dispatch.status,
      requestedInputCount: dispatch.requestedInputCount,
      ...(dispatch.acceptedInputCount === undefined
        ? {}
        : { acceptedInputCount: dispatch.acceptedInputCount }),
    };
  }
  for (const field of ARRAY_FIELDS) {
    if (Array.isArray(observation[field])) output[field] = [];
    if (observation[`${field}Truncated`] !== undefined)
      output[`${field}Truncated`] = observation[`${field}Truncated`];
  }
  output.outputCoverage = observation.outputCoverage;
  output.outputError = {
    code: "computer_observation_metadata_too_large",
    message:
      "Descriptive metadata exceeds the output limit. Identity, image geometry, and input dispatch counts are retained; other metadata is omitted.",
  };
  return output;
}

function record(value: unknown): Observation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Observation;
}

function fits(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= COMPUTER_OBSERVATION_OUTPUT_MAX_BYTES
  );
}
