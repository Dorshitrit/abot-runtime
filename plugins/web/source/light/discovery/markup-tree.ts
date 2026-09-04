import { Parser } from "htmlparser2";

import { WebPluginError } from "../../errors.js";

export type MarkupElement = {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: (MarkupElement | string)[];
  parent?: MarkupElement;
};

const MAX_MARKUP_NODES = 32_768;
const MAX_MARKUP_DEPTH = 64;

function rejectUnsafeDeclarations(markup: string, xmlMode: boolean): void {
  if (/<!entity\b/iu.test(markup)) {
    throw new WebPluginError(
      "web_response_invalid",
      "Entity declarations are not supported.",
    );
  }
  const declarations = markup.match(/<!doctype\b[^>]*>/giu) ?? [];
  const hasUnsafeDoctype = declarations.some(
    (declaration) => xmlMode || !/^<!doctype\s+html\s*>$/iu.test(declaration),
  );
  if (hasUnsafeDoctype) {
    throw new WebPluginError(
      "web_response_invalid",
      "Document type declarations are not supported.",
    );
  }
}

function assertMarkupCapacity(nodes: number, depth: number): void {
  if (nodes > MAX_MARKUP_NODES) {
    throw new WebPluginError(
      "web_response_invalid",
      "The source markup exceeds parsing limits.",
    );
  }
  if (depth > MAX_MARKUP_DEPTH) {
    throw new WebPluginError(
      "web_response_invalid",
      "The source markup exceeds parsing limits.",
    );
  }
}

export function parseMarkup(markup: string, xmlMode: boolean): MarkupElement {
  rejectUnsafeDeclarations(markup, xmlMode);
  const root: MarkupElement = {
    name: "#document",
    attributes: {},
    children: [],
  };
  const stack = [root];
  let nodes = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        nodes += 1;
        assertMarkupCapacity(nodes, stack.length);
        const parent = stack[stack.length - 1]!;
        const element: MarkupElement = {
          name,
          attributes,
          children: [],
          parent,
        };
        parent.children.push(element);
        stack.push(element);
      },
      ontext(text) {
        nodes += 1;
        assertMarkupCapacity(nodes, stack.length);
        stack[stack.length - 1]!.children.push(text);
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    {
      xmlMode,
      decodeEntities: true,
      recognizeCDATA: true,
      lowerCaseTags: !xmlMode,
      lowerCaseAttributeNames: !xmlMode,
    },
  );
  parser.end(markup);
  return root;
}

export function localName(element: MarkupElement): string {
  return element.name.split(":").at(-1)!.toLowerCase();
}

export function childElements(
  element: MarkupElement,
): readonly MarkupElement[] {
  return element.children.filter(
    (child): child is MarkupElement => typeof child !== "string",
  );
}

export function descendants(element: MarkupElement): readonly MarkupElement[] {
  const result: MarkupElement[] = [];
  const queue = [...childElements(element)].reverse();
  while (queue.length > 0) {
    const current = queue.pop()!;
    result.push(current);
    const children = childElements(current);
    for (let index = children.length - 1; index >= 0; index -= 1)
      queue.push(children[index]!);
  }
  return result;
}

export function elementText(element: MarkupElement): string {
  const values: string[] = [];
  const pending: (MarkupElement | string)[] = [...element.children].reverse();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current === "string") {
      values.push(current);
      continue;
    }
    values.push(" ");
    pending.push(" ");
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      pending.push(current.children[index]!);
    }
  }
  return values.join("").replace(/\s+/gu, " ").trim();
}

export function firstChildText(
  element: MarkupElement,
  names: readonly string[],
): string {
  const child = childElements(element).find((candidate) =>
    names.includes(localName(candidate)),
  );
  return child ? elementText(child) : "";
}
