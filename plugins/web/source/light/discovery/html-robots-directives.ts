import { localName, type MarkupElement } from "./markup-tree.js";

export type HtmlRobotsDirectives = Readonly<{
  noIndex: boolean;
  noFollow: boolean;
}>;

function isRobotsMeta(element: MarkupElement): boolean {
  if (localName(element) !== "meta") return false;
  return (element.attributes.name ?? "").trim().toLowerCase() === "robots";
}

export function readHtmlRobotsDirectives(
  elements: readonly MarkupElement[],
): HtmlRobotsDirectives {
  const directives = new Set(
    elements
      .filter(isRobotsMeta)
      .flatMap((element) =>
        (element.attributes.content ?? "").toLowerCase().split(/[\s,]+/u),
      ),
  );
  if (directives.has("none"))
    return Object.freeze({ noIndex: true, noFollow: true });
  return Object.freeze({
    noIndex: directives.has("noindex"),
    noFollow: directives.has("nofollow"),
  });
}
