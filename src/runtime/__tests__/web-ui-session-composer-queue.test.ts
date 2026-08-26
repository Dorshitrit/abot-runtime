import { describe, expect, test } from "vitest";

import {
  SESSION_COMPOSER_QUEUE_STORAGE_KEY,
  createSessionComposerQueue,
} from "../../web-ui/app/lib/session-composer-queue.js";

function createMemoryStorage(initial = new Map<string, string>()) {
  return {
    getItem(key: string) {
      return initial.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      initial.set(key, value);
    },
  };
}

function item(text: string, waitForRequestId = "request-1") {
  return {
    waitForRequestId,
    text,
    attachments: [
      {
        id: `attachment-${text}`,
        storageRef: `session/${text}`,
        mimeType: "text/plain",
      },
    ],
    agentMode: "reasoning",
    toolPermissionMode: "full_access",
    modelPreference: { profileId: "local-model" },
  };
}

describe("session composer queue", () => {
  test("isolates FIFO items by environment and session", () => {
    const queue = createSessionComposerQueue({
      storage: createMemoryStorage(),
    });
    const one = { environmentId: "dev", sessionId: "one" };
    const two = { environmentId: "dev", sessionId: "two" };
    const otherEnvironment = { environmentId: "test", sessionId: "one" };

    queue.enqueue(one, item("first"));
    queue.enqueue(one, item("second"));
    queue.enqueue(two, item("other-session"));
    queue.enqueue(otherEnvironment, item("other-environment"));

    expect(queue.list(one).map((entry) => entry.text)).toEqual([
      "first",
      "second",
    ]);
    expect(queue.peek(two)?.text).toBe("other-session");
    expect(queue.peek(otherEnvironment)?.text).toBe("other-environment");
  });

  test("serializes snapshots and restores them after refresh", () => {
    const storage = createMemoryStorage();
    const scope = { environmentId: "dev", sessionId: "session" };
    const firstQueue = createSessionComposerQueue({ storage });
    const source = item("persisted");

    firstQueue.enqueue(scope, source);
    source.text = "mutated";
    source.attachments[0].id = "mutated";

    const refreshedQueue = createSessionComposerQueue({ storage });
    const restored = refreshedQueue.peek(scope);
    expect(restored).toEqual(item("persisted"));

    if (restored) restored.attachments[0].id = "consumer-mutation";
    expect(refreshedQueue.peek(scope)).toEqual(item("persisted"));
  });

  test("releases only an exact terminal request match", () => {
    const queue = createSessionComposerQueue({
      storage: createMemoryStorage(),
    });
    const scope = { environmentId: "dev", sessionId: "session" };
    queue.enqueue(scope, item("first", "request-exact"));

    expect(queue.releaseForTerminal(scope, "request-other")).toBeNull();
    expect(queue.peek(scope)?.text).toBe("first");

    const released = queue.releaseForTerminal(scope, "request-exact");
    expect(released?.item.text).toBe("first");
    expect(released?.releaseToken).toEqual(expect.any(String));
    expect(queue.peek(scope)).toBeNull();
  });

  test("keeps duplicate terminal frames behind a persisted release barrier", () => {
    const storage = createMemoryStorage();
    const scope = { environmentId: "dev", sessionId: "session" };
    const queue = createSessionComposerQueue({ storage });
    queue.enqueue(scope, item("first"));
    queue.enqueue(scope, item("second"));

    const released = queue.releaseForTerminal(scope, "request-1");
    expect(released?.item.text).toBe("first");
    expect(queue.getBlockedRelease(scope)).toEqual(released);
    expect(queue.releaseForTerminal(scope, "request-1")).toBeNull();

    const refreshedQueue = createSessionComposerQueue({ storage });
    expect(refreshedQueue.releaseForTerminal(scope, "request-1")).toBeNull();
    expect(refreshedQueue.getBlockedRelease(scope)).toEqual(released);
    expect(refreshedQueue.peek(scope)?.text).toBe("second");
  });

  test("persists an isolated released snapshot until success resolves it", () => {
    const storage = createMemoryStorage();
    const scope = { environmentId: "dev", sessionId: "session" };
    const queue = createSessionComposerQueue({ storage });
    queue.enqueue(scope, item("released"));
    queue.enqueue(scope, item("remaining"));

    const released = queue.releaseForTerminal(scope, "request-1");
    expect(released).not.toBeNull();
    if (!released) return;
    released.item.text = "consumer-mutation";
    released.item.attachments[0].id = "consumer-mutation";

    const refreshedQueue = createSessionComposerQueue({ storage });
    expect(refreshedQueue.getBlockedRelease(scope)).toEqual({
      releaseToken: released.releaseToken,
      item: item("released"),
    });
    expect(
      refreshedQueue.bindReleasedSuccess(
        scope,
        released.releaseToken,
        "request-2",
      ),
    ).toBe(true);
    expect(refreshedQueue.getBlockedRelease(scope)).toBeNull();
    expect(refreshedQueue.peek(scope)?.waitForRequestId).toBe("request-2");
  });

  test("persists edits to a blocked release without clearing its barrier", () => {
    const storage = createMemoryStorage();
    const scope = { environmentId: "dev", sessionId: "session" };
    const queue = createSessionComposerQueue({ storage });
    queue.enqueue(scope, item("original"));
    const released = queue.releaseForTerminal(scope, "request-1");
    expect(released).not.toBeNull();
    if (!released) return;

    expect(
      queue.updateBlockedRelease(scope, released.releaseToken, {
        ...released.item,
        text: "edited draft",
        attachments: [{ id: "edited-attachment" }],
      }),
    ).toBe(true);

    const refreshedQueue = createSessionComposerQueue({ storage });
    expect(refreshedQueue.getBlockedRelease(scope)).toMatchObject({
      releaseToken: released.releaseToken,
      item: {
        text: "edited draft",
        attachments: [{ id: "edited-attachment" }],
      },
    });
    expect(
      refreshedQueue.updateBlockedRelease(scope, "wrong-token", released.item),
    ).toBe(false);
  });

  test("preserves FIFO order and rebinds only the next head after a start", () => {
    const queue = createSessionComposerQueue({
      storage: createMemoryStorage(),
    });
    const scope = { environmentId: "dev", sessionId: "session" };
    queue.enqueue(scope, item("first"));
    queue.enqueue(scope, item("second"));
    queue.enqueue(scope, item("third"));

    const first = queue.releaseForTerminal(scope, "request-1");
    expect(first?.item.text).toBe("first");
    expect(queue.bindReleasedSuccess(scope, "stale-token", "request-2")).toBe(
      false,
    );
    expect(queue.releaseForTerminal(scope, "request-1")).toBeNull();
    expect(
      queue.bindReleasedSuccess(scope, first?.releaseToken ?? "", "request-2"),
    ).toBe(true);
    expect(queue.releaseForTerminal(scope, "request-1")).toBeNull();

    const second = queue.releaseForTerminal(scope, "request-2");
    expect(second?.item.text).toBe("second");
    expect(
      queue.bindReleasedSuccess(scope, second?.releaseToken ?? "", "request-3"),
    ).toBe(true);
    expect(queue.releaseForTerminal(scope, "request-3")?.item.text).toBe(
      "third",
    );
  });

  test("recovers a persisted blocked queue by rebinding its remaining head", () => {
    const storage = createMemoryStorage();
    const scope = { environmentId: "dev", sessionId: "session" };
    const queue = createSessionComposerQueue({ storage });
    queue.enqueue(scope, item("first"));
    queue.enqueue(scope, item("second"));
    expect(queue.releaseForTerminal(scope, "request-1")?.item.text).toBe(
      "first",
    );

    const refreshedQueue = createSessionComposerQueue({ storage });
    expect(refreshedQueue.getBlockedRelease(scope)?.item.text).toBe("first");
    expect(refreshedQueue.rebindBlocked(scope, "manual-request")).toBe(true);
    expect(refreshedQueue.getBlockedRelease(scope)).toBeNull();
    expect(refreshedQueue.rebindBlocked(scope, "other-request")).toBe(false);
    expect(refreshedQueue.releaseForTerminal(scope, "request-1")).toBeNull();
    expect(
      refreshedQueue.releaseForTerminal(scope, "manual-request")?.item.text,
    ).toBe("second");
  });

  test("removes an empty blocked record during explicit recovery", () => {
    const persisted = new Map<string, string>();
    const storage = createMemoryStorage(persisted);
    const scope = { environmentId: "dev", sessionId: "session" };
    const queue = createSessionComposerQueue({ storage });
    queue.enqueue(scope, item("only"));
    expect(queue.releaseForTerminal(scope, "request-1")?.item.text).toBe(
      "only",
    );

    expect(queue.rebindBlocked(scope, "manual-request")).toBe(true);
    expect(queue.rebindBlocked(scope, "manual-request")).toBe(false);
    expect(
      JSON.parse(persisted.get(SESSION_COMPOSER_QUEUE_STORAGE_KEY) ?? ""),
    ).toEqual({ version: 1, queues: [] });
  });

  test("preserves legacy v1 queued items with or without an old barrier", () => {
    const scope = { environmentId: "dev", sessionId: "session" };
    const unblockedStorage = createMemoryStorage(
      new Map([
        [
          SESSION_COMPOSER_QUEUE_STORAGE_KEY,
          JSON.stringify({
            version: 1,
            queues: [
              {
                ...scope,
                blockedByReleaseToken: null,
                items: [item("legacy")],
              },
            ],
          }),
        ],
      ]),
    );
    const unblockedQueue = createSessionComposerQueue({
      storage: unblockedStorage,
    });
    expect(
      unblockedQueue.releaseForTerminal(scope, "request-1")?.item.text,
    ).toBe("legacy");
    expect(unblockedQueue.getBlockedRelease(scope)?.item.text).toBe("legacy");

    const blockedStorage = createMemoryStorage(
      new Map([
        [
          SESSION_COMPOSER_QUEUE_STORAGE_KEY,
          JSON.stringify({
            version: 1,
            queues: [
              {
                ...scope,
                blockedByReleaseToken: "legacy-release",
                items: [item("remaining")],
              },
            ],
          }),
        ],
      ]),
    );
    const blockedQueue = createSessionComposerQueue({
      storage: blockedStorage,
    });
    expect(blockedQueue.getBlockedRelease(scope)).toBeNull();
    expect(blockedQueue.releaseForTerminal(scope, "request-1")).toBeNull();
    expect(blockedQueue.rebindBlocked(scope, "manual-request")).toBe(true);
    expect(
      blockedQueue.releaseForTerminal(scope, "manual-request")?.item.text,
    ).toBe("remaining");
  });

  test.each([
    "{not-json",
    JSON.stringify({ version: 2, queues: [] }),
    JSON.stringify({ version: 1, queues: [{ environmentId: "dev" }] }),
    JSON.stringify({
      version: 1,
      queues: [
        {
          environmentId: "dev",
          sessionId: "session",
          blockedByReleaseToken: null,
          items: [{ ...item("bad"), attachments: ["not-a-reference"] }],
        },
      ],
    }),
  ])("fails closed for corrupted persisted storage", (persisted) => {
    const storage = createMemoryStorage(
      new Map([[SESSION_COMPOSER_QUEUE_STORAGE_KEY, persisted]]),
    );
    const queue = createSessionComposerQueue({ storage });
    const scope = { environmentId: "dev", sessionId: "session" };

    expect(queue.list(scope)).toEqual([]);
    expect(queue.releaseForTerminal(scope, "request-1")).toBeNull();
  });
});
