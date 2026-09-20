import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";
import {
  MAX_CONVERSATION_TEXT_BYTES,
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_DOWNLOAD_BYTES,
} from "../../web-ui/local-runtime/conversation-file-format.js";

let fixture: ConversationFileFixture;
beforeEach(async () => {
  fixture = await createConversationFileFixture();
});
afterEach(async () => {
  await fixture.close();
});

async function file(name: string, contents: string | Buffer) {
  const path = join(fixture.paths.agentWorkDir, name);
  await writeFile(path, contents);
  await fixture.record(fixture.receipt(path));
  return path;
}

describe("bounded current conversation file contents", () => {
  it("preserves Unicode, spaces and long logical paths without exposing physical paths", async () => {
    const folder = join(
      fixture.paths.agentWorkDir,
      "a".repeat(150),
      "b".repeat(150),
    );
    await mkdir(folder, { recursive: true });
    const name = "סיכום טיול (1).md";
    await writeFile(join(folder, name), "# שלום\n🙂");
    await fixture.record(fixture.receipt(join(folder, name)));
    const response = await fixture.read();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.file).toMatchObject({
      name,
      kind: "text",
      content: "# שלום\n🙂",
    });
    expect(JSON.stringify(data)).not.toContain(fixture.root);
    const download = await fixture.read({ download: "1" });
    expect(download.headers.get("content-disposition")).toContain(
      "filename*=UTF-8",
    );
    expect(download.headers.get("content-disposition")).toContain(
      encodeURIComponent(name).replaceAll("(", "%28").replaceAll(")", "%29"),
    );
    expect(await download.text()).toBe("# שלום\n🙂");
  });

  it("truncates UTF8 on a complete character boundary", async () => {
    const prefix = "a".repeat(MAX_CONVERSATION_TEXT_BYTES - 1);
    await file("large.txt", prefix + "🙂 tail");
    const response = await fixture.read();
    expect(response.status).toBe(200);
    const { file: preview } = await response.json();
    expect(preview.kind).toBe("text");
    expect(preview.truncated).toBe(true);
    expect(preview.content).toBe(prefix);
    expect(preview.size).toBe(Buffer.byteLength(prefix + "🙂 tail"));
    expect(await (await fixture.read({ download: "1" })).text()).toBe(
      prefix + "🙂 tail",
    );
  });

  it.each([
    ["result.json", '{"name":"test"}'],
    ["code.js", 'alert("inert")'],
    ["page.html", '<script>alert("inert")</script>'],
    ["image.svg", "<svg onload='alert(1)'/>"],
    ["empty.txt", ""],
  ])("returns %s as inert UTF8 text", async (name, contents) => {
    await file(name, contents);
    const { file: preview } = await (await fixture.read()).json();
    expect(preview).toMatchObject({
      kind: "text",
      content: contents,
      truncated: false,
    });
    expect((await fixture.read({ content: "1" })).status).toBe(415);
  });

  it.each([
    ["report.pdf", Buffer.from("%PDF-1.7 fake document")],
    ["report.docx", Buffer.from("PK zip structure")],
    ["unknown.bin", Buffer.from([0, 1, 2, 3])],
    ["invalid.txt", Buffer.from([0xc0, 0xff])],
  ])("offers metadata and attachment download for %s", async (name, bytes) => {
    await file(name, bytes);
    const { file: preview } = await (await fixture.read()).json();
    expect(preview).toMatchObject({
      kind: "unsupported",
      downloadAvailable: true,
    });
    expect(preview.content).toBeUndefined();
    expect((await fixture.read({ content: "1" })).status).toBe(415);
    const download = await fixture.read({ download: "1" });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    [
      "file.png",
      "image/png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ],
    ["file.jpeg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0])],
    ["file.webp", "image/webp", Buffer.from("RIFF0000WEBPbytes")],
  ])("serves raster image bytes for %s", async (name, mimeType, bytes) => {
    await file(name, bytes);
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { kind: "image", mimeType, truncated: false },
    });
    const response = await fixture.read({ content: "1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("does not serve non-raster bytes under a raster extension", async () => {
    await file("fake.png", "<html>untrusted</html>");
    expect((await fixture.read({ content: "1" })).status).toBe(415);
  });

  it("bounds image preview and retains the download affordance", async () => {
    const path = await file(
      "large.png",
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const handle = await open(path, "r+");
    await handle.truncate(MAX_CONVERSATION_IMAGE_BYTES + 1);
    await handle.close();
    expect(await (await fixture.read()).json()).toMatchObject({
      file: {
        kind: "unsupported",
        mimeType: "image/png",
        downloadAvailable: true,
      },
    });
    expect((await fixture.read({ content: "1" })).status).toBe(413);
  });

  it("rejects oversized download before allocating or returning full content", async () => {
    const path = await file("huge.txt", "start");
    const handle = await open(path, "r+");
    await handle.truncate(MAX_CONVERSATION_DOWNLOAD_BYTES + 1);
    await handle.close();
    const response = await fixture.read({ download: "1" });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "conversation_file_too_large",
    });
    expect(await (await fixture.read()).json()).toMatchObject({
      file: {
        downloadAvailable: false,
        size: MAX_CONVERSATION_DOWNLOAD_BYTES + 1,
      },
    });
  });

  it("returns unavailable for a missing file or replaced directory", async () => {
    await fixture.record(fixture.receipt("missing.txt"));
    expect((await fixture.read()).status).toBe(404);
    await mkdir(join(fixture.paths.agentWorkDir, "missing.txt"));
    expect((await fixture.read()).status).toBe(404);
  });
});
