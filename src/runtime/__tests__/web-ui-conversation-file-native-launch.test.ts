import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: io.spawn,
}));
import { launchMacConversationFile } from "../../web-ui/local-runtime/conversation-file-native-open.js";

afterEach(() => {
  io.spawn.mockReset();
  vi.useRealTimers();
});
function child() {
  const result = Object.assign(new EventEmitter(), { kill: vi.fn() });
  io.spawn.mockReturnValue(result);
  return result;
}

describe("fixed native Mac file launcher", () => {
  it("passes one absolute path as argv without a shell and waits for exit 0", async () => {
    const process = child();
    const path = "/test-documents/news $(touch nope); report.txt";
    const pending = launchMacConversationFile(path);
    expect(io.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/open", [path], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    process.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it.each(["error", "exit"])("sanitizes %s failure", async (event) => {
    const process = child();
    const pending = launchMacConversationFile("/private/report.txt");
    const failure = expect(pending).rejects.toMatchObject({
      code: "native_open_failed",
      statusCode: 502,
    });
    process.emit(
      event,
      event === "error" ? new Error("/private/report.txt") : 1,
    );
    await failure;
  });

  it("bounds a stuck handoff without opening any real app", async () => {
    vi.useFakeTimers();
    const process = child();
    const pending = launchMacConversationFile("/test-documents/news.txt");
    const failure = expect(pending).rejects.toMatchObject({
      code: "native_open_failed",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    expect(process.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("rejects relative or option-like paths before dispatch", async () => {
    await expect(
      launchMacConversationFile("-a Calculator"),
    ).rejects.toMatchObject({ code: "native_open_failed" });
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
