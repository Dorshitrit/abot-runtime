const MAX_PARTIAL_BODY_PREFIX_BYTES = 16_384;

/** Retains the first source bytes without allocating more storage as the stream grows. */
export class ProviderResponsePrefix {
  private readonly bytes = Buffer.alloc(MAX_PARTIAL_BODY_PREFIX_BYTES);
  private usedBytes = 0;

  append(chunk: Uint8Array): void {
    const length = Math.min(chunk.byteLength, this.bytes.length - this.usedBytes);
    this.bytes.set(chunk.subarray(0, length), this.usedBytes);
    this.usedBytes += length;
  }

  snapshot(): Buffer {
    return Buffer.from(this.bytes.subarray(0, this.usedBytes));
  }
}
