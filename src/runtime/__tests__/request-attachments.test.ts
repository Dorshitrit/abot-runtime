import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RuntimeAttachmentReference } from "../attachments/store.js";
import { appendRequestAttachmentManifest } from "../orchestration/request/request-attachment-prompt.js";
import {
  MAX_REQUEST_ATTACHMENTS,
  resolveModelGatewayAttachments,
  resolveRequestAttachments,
  resolveToolRequestAttachments,
  resolvedModelStepSupportsImageAttachments,
} from "../orchestration/request/request-attachments.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "llm-runtime-request-attachments-"),
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function imageAttachment(index: number): RuntimeAttachmentReference {
  return {
    id: `att-${index}`,
    kind: "image",
    mimeType: "image/png",
    storageRef: `session/request/att-${index}.png`,
  };
}

describe("request attachment model support", () => {
  test("uses the resolved model step profile when checking image support", () => {
    const modelPolicy = {
      providers: {
        ollama: { type: "ollama" as const },
      },
      profiles: {
        text: {
          provider: "ollama",
          model: "text-model",
          capabilities: {
            inputModalities: ["text"],
          },
        },
        vision: {
          provider: "ollama",
          model: "vision-model",
          capabilities: {
            inputModalities: ["text", "image"],
          },
        },
      },
      defaults: {
        profileId: "text",
        steps: {
          "chat.final": "vision",
        },
      },
    };

    expect(
      resolvedModelStepSupportsImageAttachments({
        modelStep: "chat.final",
        modelPolicy,
      }),
    ).toBe(true);
    expect(
      resolvedModelStepSupportsImageAttachments({
        modelStep: "decision.initial",
        modelPolicy,
      }),
    ).toBe(false);
  });

  test("supports image modality through any configured provider adapter", () => {
    expect(
      resolvedModelStepSupportsImageAttachments({
        modelStep: "chat.final",
        modelPolicy: {
          providers: {
            remote: { type: "third-provider" },
          },
          profiles: {
            vision: {
              provider: "remote",
              model: "vision-model",
              capabilities: {
                inputModalities: ["text", "image"],
              },
            },
          },
          defaults: {
            profileId: "vision",
          },
        },
      }),
    ).toBe(true);
  });

  test("does not infer image support when the provider is unresolved", () => {
    const imageProfile = {
      model: "vision-model",
      capabilities: {
        inputModalities: ["text", "image"] as const,
      },
    };

    expect(
      resolvedModelStepSupportsImageAttachments({
        modelStep: "chat.final",
        modelPolicy: {
          providers: {
            local: { type: "ollama" },
          },
          profiles: {
            vision: imageProfile,
          },
          defaults: {
            profileId: "vision",
          },
        },
      }),
    ).toBe(false);

    expect(
      resolvedModelStepSupportsImageAttachments({
        modelStep: "chat.final",
        modelPolicy: {
          providers: {
            local: { type: "ollama" },
          },
          profiles: {
            vision: {
              ...imageProfile,
              provider: "missing",
            },
          },
          defaults: {
            profileId: "vision",
          },
        },
      }),
    ).toBe(false);
  });
});

describe("request attachment resolution", () => {
  test("deduplicates references before resolving gateway payloads", async () => {
    const root = await createTempRoot();
    const absolutePath = join(root, "image.png");
    await writeFile(absolutePath, Buffer.from([1, 2, 3]));
    const attachment = imageAttachment(1);
    const resolveAttachment = vi.fn(async () => ({
      metadata: attachment,
      absolutePath,
    }));

    const resolved = await resolveModelGatewayAttachments({
      attachments: [attachment, { ...attachment, id: "att-duplicate" }],
      attachmentStore: {
        saveAttachment: vi.fn(),
        validateAttachmentReferences: vi.fn(),
        resolveAttachment,
        deleteSessionAttachments: vi.fn(),
      },
    });

    expect(resolveAttachment).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: "att-1",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  test("bounds unique attachment refs before validation or file reads", async () => {
    const attachments = Array.from(
      { length: MAX_REQUEST_ATTACHMENTS + 1 },
      (_, index) => imageAttachment(index),
    );
    const attachmentStore = {
      saveAttachment: vi.fn(),
      validateAttachmentReferences: vi.fn(),
      resolveAttachment: vi.fn(),
      deleteSessionAttachments: vi.fn(),
    };

    await expect(
      resolveRequestAttachments({
        rawAttachments: attachments,
        sessionId: "session",
        attachmentStore,
      }),
    ).rejects.toThrow("attachment_count_exceeded");
    await expect(
      resolveModelGatewayAttachments({
        attachments,
        attachmentStore,
      }),
    ).rejects.toThrow("attachment_count_exceeded");
    expect(attachmentStore.validateAttachmentReferences).not.toHaveBeenCalled();
    expect(attachmentStore.resolveAttachment).not.toHaveBeenCalled();
  });

  test("keeps document bytes out of the model gateway and exposes a request-bound tool handle", async () => {
    const root = await createTempRoot();
    const absolutePath = join(root, "brief.pdf");
    await writeFile(absolutePath, "%PDF-1.4", "utf8");
    const attachment: RuntimeAttachmentReference = {
      id: "att-brief",
      kind: "file",
      mimeType: "application/pdf",
      storageRef: "session/request/att-brief.pdf",
      name: "brief.pdf",
      size: 8,
    };
    const attachmentStore = {
      saveAttachment: vi.fn(),
      validateAttachmentReferences: vi.fn(),
      resolveAttachment: vi.fn(async () => ({
        metadata: attachment,
        absolutePath,
      })),
      deleteSessionAttachments: vi.fn(),
    };

    await expect(
      resolveModelGatewayAttachments({
        attachments: [attachment],
        attachmentStore,
      }),
    ).resolves.toEqual([]);
    const handles = await resolveToolRequestAttachments({
      attachments: [attachment],
      attachmentStore,
    });

    expect(handles).toEqual([
      expect.objectContaining({
        id: "att-brief",
        kind: "file",
        absolutePath,
      }),
    ]);
    expect(appendRequestAttachmentManifest("Summarize this", handles)).toBe(
      [
        "Summarize this",
        "",
        "Attached files available through the document reader tool:",
        '- id="att-brief" name="brief.pdf" mime="application/pdf" bytes=8',
      ].join("\n"),
    );
  });
});
