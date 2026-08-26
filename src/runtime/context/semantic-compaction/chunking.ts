import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "./contracts.js";

export type SemanticCompactionSourceSlice = Readonly<{
  sourceRef: string;
  sourceFingerprint: string;
  range: Readonly<{
    startByte: number;
    endByteExclusive: number;
    totalBytes: number;
  }>;
  sliceFingerprint: string;
  content: string;
}>;

export type SemanticCompactionUtf8Boundary = Readonly<{
  codeUnitIndex: number;
  byteOffset: number;
}>;

/** Returns every valid UTF-8/code-point boundary, including zero and EOF. */
export function projectSemanticCompactionUtf8Boundaries(
  content: string,
): readonly SemanticCompactionUtf8Boundary[] {
  const boundaries: SemanticCompactionUtf8Boundary[] = [
    Object.freeze({ codeUnitIndex: 0, byteOffset: 0 }),
  ];
  let codeUnitIndex = 0;
  let byteOffset = 0;
  for (const codePoint of content) {
    codeUnitIndex += codePoint.length;
    byteOffset += Buffer.byteLength(codePoint, "utf8");
    boundaries.push(Object.freeze({ codeUnitIndex, byteOffset }));
  }
  return Object.freeze(boundaries);
}

export function createSemanticCompactionSourceSlice(params: {
  source: SemanticCompactionSource;
  boundaries: readonly SemanticCompactionUtf8Boundary[];
  startBoundaryIndex: number;
  endBoundaryIndex: number;
}): SemanticCompactionSourceSlice {
  const { source, boundaries, startBoundaryIndex, endBoundaryIndex } = params;
  const start = boundaries[startBoundaryIndex];
  const end = boundaries[endBoundaryIndex];
  const total = boundaries.at(-1);
  if (
    !start ||
    !end ||
    !total ||
    !Number.isSafeInteger(startBoundaryIndex) ||
    !Number.isSafeInteger(endBoundaryIndex) ||
    startBoundaryIndex < 0 ||
    endBoundaryIndex <= startBoundaryIndex ||
    endBoundaryIndex >= boundaries.length ||
    start.byteOffset >= end.byteOffset ||
    createSemanticCompactionSha256Fingerprint(source.content) !==
      source.sourceFingerprint
  ) {
    throw new Error("context_compaction_source_slice_invalid");
  }
  const content = source.content.slice(start.codeUnitIndex, end.codeUnitIndex);
  if (
    Buffer.byteLength(content, "utf8") !==
    end.byteOffset - start.byteOffset
  ) {
    throw new Error("context_compaction_source_slice_range_invalid");
  }
  return Object.freeze({
    sourceRef: source.sourceRef,
    sourceFingerprint: source.sourceFingerprint,
    range: Object.freeze({
      startByte: start.byteOffset,
      endByteExclusive: end.byteOffset,
      totalBytes: total.byteOffset,
    }),
    sliceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}
