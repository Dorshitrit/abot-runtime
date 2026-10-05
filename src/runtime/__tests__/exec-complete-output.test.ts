import { afterEach, describe, expect, test } from "vitest";
import { ExecOutputBuffer } from "../../../plugins/exec/source/process-output-buffer.js";
import { createExecCommandPathFixture } from "./support/exec-command-path-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);

describe("complete EXEC evidence for runtime compaction", () => {
  test("preserves output beyond the former character quota in one canonical field", async () => {
    const { plugin } = await createExecCommandPathFixture();
    const output = "evidence_".repeat(2_000);
    const result = await plugin.handlers.exec!({
      cwd: ".",
      command: `printf '%s' evidence_ | awk '{for(i=0;i<2000;i++)printf "%s",$0}'`,
    });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: output,
      stderr: "",
    });
    expect(result.output).not.toContain(output);
    expect(result.data).toMatchObject({
      outputBounds: {
        maxChars: null,
        stdout: {
          truncated: false,
          originalChars: output.length,
          returnedChars: output.length,
          omittedChars: 0,
        },
      },
    });
  });

  test("accepts a complete command at the declared input limit", async () => {
    const { plugin } = await createExecCommandPathFixture();
    const prefix = "printf complete #";
    const command = prefix + "x".repeat(8_192 - prefix.length);
    const result = await plugin.handlers.exec!({ cwd: ".", command });
    expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: "complete" });
  });

  test("incremental snapshots preserve all new content and distinguish previously consumed output", () => {
    const buffer = new ExecOutputBuffer();
    const first = "\u05e9\u05dc\u05d5\u05dd\u{1F680}".repeat(2_000);
    buffer.append(first);
    buffer.append("tail");
    expect(buffer.peek().text).toBe(first + "tail");
    expect(buffer.consume()).toMatchObject({
      text: first + "tail",
      sawOutput: true,
      metadata: { truncated: false, omittedChars: 0 },
    });
    expect(buffer.consume()).toMatchObject({ text: "", sawOutput: true });
    buffer.append("fresh");
    expect(buffer.consume().text).toBe("fresh");
  });
});
