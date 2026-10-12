import { afterEach, describe, expect, test } from "vitest";
import { getProcessFilesystemMutationCoordinator } from "../../../plugins/filesystem/source/mutation-coordinator.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
afterEach(() => Object.defineProperty(process, "platform", platformDescriptor));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("filesystem mutation coordination", () => {
  test.each(["win32", "linux", "darwin"])(
    "coordinates case variants according to the %s host",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const firstInstance = getProcessFilesystemMutationCoordinator();
      const secondInstance = getProcessFilesystemMutationCoordinator();
      const hold = barrier();
      const events: string[] = [];
      const first = firstInstance.runExclusive(
        "C:\\work\\Report.txt",
        async () => {
          events.push("first");
          await hold.promise;
          events.push("first done");
        },
      );
      const second = secondInstance.runExclusive(
        "C:\\WORK\\report.TXT",
        async () => {
          events.push("second");
        },
      );
      await Promise.resolve();
      try {
        expect([...events]).toEqual(
          platform === "win32" ? ["first"] : ["first", "second"],
        );
      } finally {
        hold.release();
        await Promise.all([first, second]);
      }
      if (platform === "win32")
        expect(events).toEqual(["first", "first done", "second"]);
    },
  );

  test("independent Windows targets can proceed while another target is held", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const coordinator = getProcessFilesystemMutationCoordinator();
    const hold = barrier();
    let independentCompleted = false;
    const first = coordinator.runExclusive(
      "C:\\work\\first.txt",
      () => hold.promise,
    );
    const second = coordinator.runExclusive(
      "C:\\work\\second.txt",
      async () => {
        independentCompleted = true;
      },
    );
    await Promise.resolve();
    try {
      expect(independentCompleted).toBe(true);
    } finally {
      hold.release();
      await Promise.all([first, second]);
    }
  });

  test("a failed Windows mutation releases queued case variants", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const coordinator = getProcessFilesystemMutationCoordinator();
    const hold = barrier();
    const failure = new Error("write rejected");
    const first = coordinator
      .runExclusive("C:\\work\\note.txt", async () => {
        await hold.promise;
        throw failure;
      })
      .catch((error: unknown) => error);
    let nextCompleted = false;
    const second = coordinator.runExclusive("C:\\WORK\\NOTE.TXT", async () => {
      nextCompleted = true;
    });
    await Promise.resolve();
    try {
      expect(nextCompleted).toBe(false);
    } finally {
      hold.release();
      await Promise.all([first, second]);
    }
    expect(await first).toBe(failure);
    expect(nextCompleted).toBe(true);
    await expect(
      coordinator.runExclusive("C:\\work\\Note.Txt", async () => "saved"),
    ).resolves.toBe("saved");
  });
});
