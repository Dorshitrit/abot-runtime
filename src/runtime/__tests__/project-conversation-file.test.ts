import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { captureFileOutputRootId } from "../capabilities/file-output-root-identity.js";
import { createConversationFileFixture } from "./support/conversation-file-test-fixture.js";

test("project file preview opens the saved project root rather than a same-name default file", async () => {
  const fixture = await createConversationFileFixture();
  try {
    const directory = join(fixture.root, "selected-project");
    await mkdir(directory);
    await writeFile(join(directory, "result.txt"), "project result");
    await writeFile(
      join(fixture.paths.agentWorkDir, "result.txt"),
      "unrelated default result",
    );
    await fixture.sessions.getOrCreateSession("project-chat", {
      project: { id: "project-id", name: "Selected project", directory },
    });
    await fixture.sessions.startRequestStream(
      "project-chat",
      "project-request",
    );
    await fixture.sessions.appendRequestEvent(
      "project-chat",
      "project-request",
      fixture.completion(
        {
          version: 1,
          location: "agent_work",
          rootId: captureFileOutputRootId("agent_work", directory),
          relativePath: "result.txt",
          logicalPath: "result.txt",
          operation: "created",
        },
        { requestId: "project-request" },
      ),
    );
    const response = await fixture.read({
      sessionId: "project-chat",
      requestId: "project-request",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.stringify(result)).toContain("project result");
    expect(JSON.stringify(result)).not.toContain("unrelated default result");
    await fixture.sessions.clearSessionMessages("project-chat");
    expect(
      (
        await fixture.read({
          sessionId: "project-chat",
          requestId: "project-request",
        })
      ).status,
    ).toBe(404);
  } finally {
    await fixture.close();
  }
});
