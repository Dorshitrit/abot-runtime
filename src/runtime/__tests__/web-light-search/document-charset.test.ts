import { describe, expect, test } from "vitest";

import { parseLightDocument } from "../../../../plugins/web/source/light/documents/extract-document.js";
import type { PublicHttpResponse } from "../../../../plugins/web/source/public-http.js";

function encodedResponse(
  body: Buffer,
  contentType: string,
): PublicHttpResponse {
  return {
    requestedUrl: "https://publisher.example/",
    finalUrl: "https://publisher.example/",
    status: 200,
    headers: { "content-type": contentType },
    body,
    bytesRead: body.length,
    partialContent: false,
  };
}

function windows1255(text: string): Buffer {
  return Buffer.from(
    [...text].map((character) => {
      const point = character.codePointAt(0)!;
      if (point >= 0x05d0 && point <= 0x05ea) return point - 0x05d0 + 0xe0;
      if (point < 128) return point;
      throw new Error(
        "The charset fixture only supports ASCII and Hebrew letters.",
      );
    }),
  );
}

describe("Light declared document charset", () => {
  test("preserves UTF-8 Hebrew with an omitted charset", () => {
    const body = Buffer.from('<title>חדשות</title><a href="/כתבה">כתבה</a>');
    expect(
      parseLightDocument(encodedResponse(body, "text/html"), 5),
    ).toMatchObject({ title: "חדשות", links: [{ title: "כתבה" }] });
  });

  test("preserves Windows-1255 page title, text and discovered URL", () => {
    const body = windows1255(
      '<title>חדשות</title><main>כתבות מחקר</main><a href="/כתבה">כתבה</a>',
    );
    const document = parseLightDocument(
      encodedResponse(body, 'text/html; charset="windows-1255"'),
      5,
    );
    expect(document.title).toBe("חדשות");
    expect(document.text).toContain("כתבות מחקר");
    expect(document.links).toEqual([
      {
        url: "https://publisher.example/%D7%9B%D7%AA%D7%91%D7%94",
        title: "כתבה",
        kind: "page",
      },
    ]);
  });

  test("reads an XML encoding declaration when HTTP omits charset", () => {
    const body = windows1255(
      '<?xml version="1.0" encoding="windows-1255"?><rss><channel><title>חדשות</title><item><title>כתבה</title><link>/כתבה</link></item></channel></rss>',
    );
    const document = parseLightDocument(
      encodedResponse(body, "application/rss+xml"),
      5,
    );
    expect(document.title).toBe("חדשות");
    expect(document.links[0]).toMatchObject({
      title: "כתבה",
      url: "https://publisher.example/%D7%9B%D7%AA%D7%91%D7%94",
    });
  });

  test("uses a UTF-16 BOM for XML discovery", () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        "<rss><channel><title>חדשות</title></channel></rss>",
        "utf16le",
      ),
    ]);
    expect(
      parseLightDocument(encodedResponse(body, "application/rss+xml"), 5),
    ).toMatchObject({ kind: "feed", title: "חדשות" });
  });

  test.each(["utf-16le", "utf-16be"])(
    "supports %s with a declared charset",
    (charset) => {
      const body = Buffer.from(
        "<title>חדשות</title><main>מחקר</main>",
        "utf16le",
      );
      if (charset === "utf-16be") body.swap16();
      expect(
        parseLightDocument(
          encodedResponse(body, `text/html; charset=${charset}`),
          5,
        ),
      ).toMatchObject({
        title: "חדשות",
        text: expect.stringContaining("מחקר"),
      });
    },
  );

  test("gives a BOM precedence over HTTP and HTTP precedence over an XML declaration", () => {
    const bomBody = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<title>חדשות</title>"),
    ]);
    expect(
      parseLightDocument(
        encodedResponse(bomBody, "text/html; charset=windows-1255"),
        5,
      ).title,
    ).toBe("חדשות");
    const xml =
      '<?xml version="1.0" encoding="windows-1255"?><rss><channel><title>חדשות</title></channel></rss>';
    expect(
      parseLightDocument(
        encodedResponse(Buffer.from(xml), "application/rss+xml; charset=utf-8"),
        5,
      ).title,
    ).toBe("חדשות");
  });

  test("accepts the standard ISO-8859-1 alias for Western publisher text", () => {
    const body = Buffer.from("<title>Caf\u00e9</title>", "latin1");
    expect(
      parseLightDocument(
        encodedResponse(body, "text/html; charset=iso-8859-1"),
        5,
      ).title,
    ).toBe("Café");
  });

  test("rejects an unsupported declared charset explicitly", () => {
    expect(() =>
      parseLightDocument(
        encodedResponse(
          Buffer.from("Source text"),
          "text/plain; charset=x-unknown",
        ),
        5,
      ),
    ).toThrow(expect.objectContaining({ code: "web_response_unsupported" }));
  });

  test("rejects malformed UTF-8 instead of returning replacement characters", () => {
    expect(() =>
      parseLightDocument(
        encodedResponse(Buffer.from([0xc3, 0x28]), "text/plain; charset=utf-8"),
        5,
      ),
    ).toThrow(expect.objectContaining({ code: "web_response_invalid" }));
  });

  test("rejects UTF-32 instead of interpreting its BOM as UTF-16", () => {
    expect(() =>
      parseLightDocument(
        encodedResponse(
          Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00]),
          "application/xml",
        ),
        5,
      ),
    ).toThrow(expect.objectContaining({ code: "web_response_unsupported" }));
  });

  test.each(["utf-8", "utf-16le"])(
    "preserves partial %s content ending inside a Hebrew character",
    (charset) => {
      const full = Buffer.from(
        "חדשות",
        charset === "utf-8" ? "utf8" : "utf16le",
      );
      const response = encodedResponse(
        full.subarray(0, -1),
        `text/plain; charset=${charset}`,
      );
      expect(
        parseLightDocument({ ...response, partialContent: true }, 5),
      ).toMatchObject({ text: "חדשו", partial: true });
    },
  );

  test("still rejects malformed interior bytes in a partial response", () => {
    const response = encodedResponse(
      Buffer.from([0xc3, 0x28, 0x61]),
      "text/plain; charset=utf-8",
    );
    expect(() =>
      parseLightDocument({ ...response, partialContent: true }, 5),
    ).toThrow(expect.objectContaining({ code: "web_response_invalid" }));
  });
});
