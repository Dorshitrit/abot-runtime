import { describe, expect, test } from "vitest";

import {
  buildMessageTimestamp,
  createMessageTimestamp,
} from "../../web-ui/app/components/message-timestamp.js";

class FakeTimeElement {
  className = "";
  dateTime = "";
  title = "";
  textContent = "";
}

const documentRoot = {
  createElement: () => new FakeTimeElement(),
} as unknown as Document;

describe("web ui message timestamps", () => {
  test("formats a canonical message timestamp in the requested local zone", () => {
    const timestamp = buildMessageTimestamp("2026-08-20T12:34:56.000Z", {
      locales: "en-GB",
      timeZone: "UTC",
    });

    expect(timestamp).toMatchObject({
      dateTime: "2026-08-20T12:34:56.000Z",
      label: "20/08/2026, 12:34",
    });
    expect(timestamp?.title).toContain("20 August 2026");
  });

  test("renders a semantic time element and omits missing or invalid values", () => {
    const node = createMessageTimestamp({
      documentRoot,
      value: 1_776_772_496_000,
      locales: "en-GB",
      timeZone: "UTC",
    }) as unknown as FakeTimeElement;

    expect(node.className).toBe("message-timestamp");
    expect(node.dateTime).toBe("2026-04-21T11:54:56.000Z");
    expect(node.textContent).toBe("21/04/2026, 11:54");
    expect(
      createMessageTimestamp({ documentRoot, value: "not-a-date" }),
    ).toBeNull();
    expect(createMessageTimestamp({ documentRoot, value: null })).toBeNull();
  });
});
