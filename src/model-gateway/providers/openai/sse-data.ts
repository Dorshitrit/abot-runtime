// Decode complete SSE data frames identically for response lifetime and output.
// Event names are metadata; the Responses payload owns its typed event.
export class OpenAISseDataDecoder {
  private readonly decoder = new TextDecoder();
  private line = "";
  private data: string[] = [];
  private afterCr = false;

  accept(bytes: Uint8Array): string[] {
    const text = this.decoder.decode(bytes, { stream: true });
    const frames: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (this.afterCr) {
        this.afterCr = false;
        if (char === "\n") { start = index + 1; continue; }
      }
      if (char !== "\r" && char !== "\n") continue;
      this.line += text.slice(start, index);
      this.acceptLine(frames);
      this.line = "";
      this.afterCr = char === "\r";
      start = index + 1;
    }
    this.line += text.slice(start);
    return frames;
  }

  private acceptLine(frames: string[]): void {
    if (!this.line) {
      if (this.data.length) frames.push(this.data.join("\n"));
      this.data = [];
      return;
    }
    const colon = this.line.indexOf(":");
    const field = colon < 0 ? this.line : this.line.slice(0, colon);
    if (field !== "data") return;
    const value = colon < 0 ? "" : this.line.slice(colon + 1);
    this.data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
}

export async function* readOpenAIDataFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new OpenAISseDataDecoder();
  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { reachedEof = true; return; }
      yield* decoder.accept(value);
    }
  } finally {
    // A tee branch cannot await cancellation before the other readers finish.
    if (!reachedEof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
