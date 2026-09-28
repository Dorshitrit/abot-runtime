import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { accepted, fixture, waitExpected } from "./support.js";

const faults = vi.hoisted(() => ({ sync: "" as "" | "file" | "directory" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const kind = args[1] === "r" ? "directory" : "file";
      if (faults.sync === kind) {
        faults.sync = "";
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error(`fixture_${kind}_sync_failed`),
        );
      }
      return handle;
    },
  };
});
afterEach(() => {
  faults.sync = "";
});

describe("durable approval commits", () => {
  test.each(["approve", "reject", "cancel"] as const)(
    "removes only the consumed continuation after %s",
    async (choice) => {
      const f = await fixture(2);
      const waiting = accepted(
        await f.service.requestLifecycle.commitWait("conversation", f.command),
      );
      const partial = accepted(
        await f.service.requestLifecycle.commitDecision("conversation", {
          expected: waitExpected(waiting.current),
          commandId: "partial",
          approvalId: "approval-1",
          approved: true,
        }),
      );
      await expect(
        f.service.requestLifecycle.readContinuation(
          "conversation",
          f.continuation,
        ),
      ).resolves.toBeDefined();
      const unrelated = await f.service.requestLifecycle.writeBlob(
        "conversation",
        Buffer.from("unrelated"),
      );
      if (choice === "cancel") {
        accepted(
          await f.service.requestLifecycle.cancelWait("conversation", {
            expected: waitExpected(partial.current),
            commandId: "cancel",
            message: { content: "Stopped." },
          }),
        );
      } else {
        accepted(
          await f.service.requestLifecycle.commitDecision("conversation", {
            expected: waitExpected(partial.current),
            commandId: "final",
            approvalId: "approval-2",
            approved: choice === "approve",
            resumeActivation: { activationId: "next", ownerEpoch: "owner" },
          }),
        );
      }
      await expect(
        f.service.requestLifecycle.readBlob(
          "conversation",
          f.continuation.blob,
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        f.service.requestLifecycle.readBlob("conversation", unrelated),
      ).resolves.toEqual(Buffer.from("unrelated"));
    },
  );

  test.each(["file", "directory"] as const)(
    "preserves continuation on an unconfirmed %s commit",
    async (kind) => {
      const f = await fixture();
      const waiting = accepted(
        await f.service.requestLifecycle.commitWait("conversation", f.command),
      );
      faults.sync = kind;
      await expect(
        f.service.requestLifecycle.cancelWait("conversation", {
          expected: waitExpected(waiting.current),
          commandId: "cancel",
          message: { content: "Stopped." },
        }),
      ).rejects.toThrow();
      await expect(
        f.service.requestLifecycle.readContinuation(
          "conversation",
          f.continuation,
        ),
      ).resolves.toBeDefined();
    },
  );

  test("failure before replacement leaves the running record unchanged", async () => {
    const f = await fixture();
    faults.sync = "file";
    await expect(
      f.service.requestLifecycle.commitWait("conversation", f.command),
    ).rejects.toThrow("fixture_file_sync_failed");
    expect(
      await f.service.requestLifecycle.get("conversation", "request"),
    ).toEqual(f.started.current);
    expect(
      (await f.service.getSessionById("conversation"))!.messages,
    ).toHaveLength(1);
    expect(
      (await readdir(f.directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("failure after decision replacement reports uncertainty without restoring the wait", async () => {
    const f = await fixture();
    const waiting = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    );
    const command = {
      expected: waitExpected(waiting.current),
      commandId: "decision",
      approvalId: "approval-1",
      approved: true,
      resumeActivation: { activationId: "activation-2", ownerEpoch: "owner-2" },
    };
    faults.sync = "directory";
    await expect(
      f.service.requestLifecycle.commitDecision("conversation", command),
    ).rejects.toMatchObject({ code: "session_commit_outcome_unknown" });
    const current = await f.service.requestLifecycle.get(
      "conversation",
      "request",
    );
    expect(current).toMatchObject({
      status: "streaming",
      activation: command.resumeActivation,
    });
    expect(current!.wait).toBeUndefined();
    expect(
      await f.service.requestLifecycle.getDecisionReceipt(
        "conversation",
        "request",
        current!.generation,
        "decision",
      ),
    ).toMatchObject({ activation: command.resumeActivation });
    expect(
      accepted(
        await f.service.requestLifecycle.commitDecision(
          "conversation",
          command,
        ),
      ),
    ).toMatchObject({ duplicate: true, events: [] });
  });

  test("a final decision without its new activation cannot consume the wait", async () => {
    const f = await fixture();
    const waiting = accepted(
      await f.service.requestLifecycle.commitWait("conversation", f.command),
    );
    expect(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(waiting.current),
        commandId: "decision",
        approvalId: "approval-1",
        approved: false,
      }),
    ).toMatchObject({ accepted: false, reason: "resume_activation_required" });
    expect(
      await f.service.requestLifecycle.get("conversation", "request"),
    ).toEqual(waiting.current);
  });
});

describe("immutable continuation content", () => {
  test("deduplicates content, accepts shared JSON values and detects corruption", async () => {
    const f = await fixture();
    const shared = { result: "saved" };
    const input = {
      schema: "fixture",
      version: 1,
      value: { first: shared, second: shared },
    };
    const first = await f.service.requestLifecycle.writeContinuation(
      "conversation",
      input,
    );
    expect(
      await f.service.requestLifecycle.writeContinuation("conversation", input),
    ).toEqual(first);
    expect(
      await f.service.requestLifecycle.readContinuation("conversation", first),
    ).toEqual(input.value);
    const target = join(
      f.directory,
      ".request-continuations",
      "conversation",
      `${first.blob.sha256}.blob`,
    );
    await writeFile(target, "tampered");
    await expect(
      f.service.requestLifecycle.readContinuation("conversation", first),
    ).rejects.toThrow("continuation_blob_integrity_mismatch");
    await expect(
      f.service.requestLifecycle.writeContinuation("conversation", input),
    ).rejects.toThrow("continuation_blob_integrity_mismatch");
    expect(await readFile(target, "utf8")).toBe("tampered");
  });

  test("rejects non-JSON values before publishing content", async () => {
    const f = await fixture();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const values = [
      cycle,
      new Date(),
      new Map(),
      Buffer.from("data"),
      { missing: undefined },
      NaN,
      1n,
      () => undefined,
    ];
    for (const value of values) {
      await expect(
        f.service.requestLifecycle.writeContinuation("conversation", {
          schema: "fixture",
          version: 1,
          value,
        }),
      ).rejects.toThrow("continuation_value_not_serializable");
    }
  });

  test("cleans temporary content after failed write and rejects unsafe references", async () => {
    const f = await fixture();
    faults.sync = "file";
    await expect(
      f.service.requestLifecycle.writeBlob(
        "conversation",
        Buffer.from("new content"),
      ),
    ).rejects.toThrow("fixture_file_sync_failed");
    const directory = join(
      f.directory,
      ".request-continuations",
      "conversation",
    );
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    await expect(
      f.service.requestLifecycle.readBlob("conversation", {
        sha256: "../escape",
        byteLength: 1,
      }),
    ).rejects.toThrow("continuation_blob_reference_invalid");
  });
});
