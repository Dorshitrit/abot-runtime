const MAX_PARTIAL_BODY_BYTES = 16_384;

/** Fixed storage: appending copies only incoming bytes, never the retained tail. */
export class ProviderResponseTail {
  private readonly bytes = Buffer.alloc(MAX_PARTIAL_BODY_BYTES);
  private writeOffset = 0;
  private usedBytes = 0;

  append(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.bytes.length) {
      this.bytes.set(chunk.subarray(chunk.byteLength - this.bytes.length));
      this.writeOffset = 0;
      this.usedBytes = this.bytes.length;
      return;
    }
    const firstLength = Math.min(chunk.byteLength, this.bytes.length - this.writeOffset);
    this.bytes.set(chunk.subarray(0, firstLength), this.writeOffset);
    this.bytes.set(chunk.subarray(firstLength), 0);
    this.writeOffset = (this.writeOffset + chunk.byteLength) % this.bytes.length;
    this.usedBytes = Math.min(this.usedBytes + chunk.byteLength, this.bytes.length);
  }

  snapshot(): Buffer {
    const result = Buffer.alloc(this.usedBytes);
    const start = (this.writeOffset - this.usedBytes + this.bytes.length) % this.bytes.length;
    const firstLength = Math.min(this.usedBytes, this.bytes.length - start);
    result.set(this.bytes.subarray(start, start + firstLength));
    result.set(this.bytes.subarray(0, this.usedBytes - firstLength), firstLength);
    return result;
  }
}
