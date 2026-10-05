import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";
import type { ExecStreamSnapshot } from "./types.js";

/** Transient text assembly for a disk observation; never holds child stream capture. */
export class ExecOutputBuffer {
  private text = "";
  private sawOutput = false;

  append(chunk: string): void {
    if (!chunk) return;
    this.sawOutput = true;
    this.text += sanitizeJsonText(chunk);
  }

  peek(): ExecStreamSnapshot {
    const text = this.text;
    return Object.freeze({
      text,
      sawOutput: this.sawOutput,
      metadata: Object.freeze({
        truncated: false,
        originalChars: text.length,
        returnedChars: text.length,
        omittedChars: 0,
      }),
    });
  }
  accept(snapshot: ExecStreamSnapshot): void {
    if (!this.text.startsWith(snapshot.text)) {
      throw new Error("exec_output_snapshot_mismatch");
    }
    this.text = this.text.slice(snapshot.text.length);
  }
  consume(): ExecStreamSnapshot {
    const result = this.peek();
    this.accept(result);
    return result;
  }
}
