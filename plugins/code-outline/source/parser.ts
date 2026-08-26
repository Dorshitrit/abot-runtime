import { parse } from "@babel/parser";

import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

export type OutlineSymbol = Readonly<{
  kind:
    | "binding"
    | "class"
    | "declaration"
    | "element"
    | "function"
    | "function_value"
    | "selector";
  name: string;
  line: number;
}>;

export type CodeOutline = Readonly<{
  symbols: readonly OutlineSymbol[];
  imports: readonly string[];
  metadata: Readonly<{
    symbolsTruncated: boolean;
    totalSymbols: number;
    returnedSymbols: number;
    importsTruncated: boolean;
    totalImports: number;
    returnedImports: number;
    truncatedSymbolNames: number;
    truncatedImportValues: number;
    symbolNameMaxChars: number;
    importValueMaxChars: number;
  }>;
}>;

const IMPORT_LIMIT = 40;
const SYMBOL_NAME_MAX_CHARS = 96;
const IMPORT_VALUE_MAX_CHARS = 128;

function boundLabel(value: string, maxChars: number): string {
  const safeValue = sanitizeJsonText(value);
  if (safeValue.length <= maxChars) return safeValue;
  const marker = "...[truncated]";
  return `${safeValue.slice(0, maxChars - marker.length)}${marker}`;
}

type BabelNode = Readonly<Record<string, unknown>> & {
  type?: string;
  loc?: Readonly<{ start?: Readonly<{ line?: number }> }> | null;
};

function nodeLine(node: BabelNode): number {
  return node.loc?.start?.line ?? 1;
}

function identifierName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.type === "Identifier" && typeof candidate.name === "string"
    ? candidate.name
    : undefined;
}

function literalValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  return typeof candidate.value === "string" ? candidate.value : undefined;
}

function parseJavaScriptOutline(source: string): {
  symbols: OutlineSymbol[];
  imports: string[];
} {
  const ast = parse(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
  const symbols: OutlineSymbol[] = [];
  const imports: string[] = [];
  const pending: unknown[] = [ast.program];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const node = current as BabelNode;

    if (node.type === "FunctionDeclaration") {
      const name = identifierName(node.id);
      if (name) symbols.push({ kind: "function", name, line: nodeLine(node) });
    } else if (node.type === "ClassDeclaration") {
      const name = identifierName(node.id);
      if (name) symbols.push({ kind: "class", name, line: nodeLine(node) });
    } else if (node.type === "VariableDeclarator") {
      const name = identifierName(node.id);
      if (name) {
        const initializer = node.init as BabelNode | undefined;
        const kind =
          initializer?.type === "ArrowFunctionExpression" ||
          initializer?.type === "FunctionExpression"
            ? "function_value"
            : "binding";
        symbols.push({ kind, name, line: nodeLine(node) });
      }
    } else if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      const value = literalValue(node.source);
      if (value) imports.push(value);
    } else if (node.type === "CallExpression") {
      const calleeName = identifierName(node.callee);
      const argumentsValue = Array.isArray(node.arguments)
        ? node.arguments
        : [];
      if (calleeName === "require") {
        const value = literalValue(argumentsValue[0]);
        if (value) imports.push(value);
      }
    }

    for (const value of Object.values(node)) {
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) pending.push(...value);
      else pending.push(value);
    }
  }
  return { symbols, imports };
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function parsePatternOutline(
  source: string,
  extension: string,
): {
  symbols: OutlineSymbol[];
  imports: string[];
} {
  const symbols: OutlineSymbol[] = [];
  const imports: string[] = [];
  const add = (expression: RegExp, kind: OutlineSymbol["kind"]) => {
    for (const match of source.matchAll(expression)) {
      const name = match[1];
      if (name)
        symbols.push({ kind, name, line: lineAt(source, match.index ?? 0) });
    }
  };

  if (extension === ".py") {
    add(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gmu, "function");
    add(/^\s*class\s+([A-Za-z_]\w*)/gmu, "class");
    for (const match of source.matchAll(/^\s*(?:from|import)\s+([^\s]+)/gmu)) {
      if (match[1]) imports.push(match[1]);
    }
  } else if (extension === ".css" || extension === ".scss") {
    add(/^([^@\n][^{\n]{1,180})\{/gmu, "selector");
  } else if (extension === ".html" || extension === ".htm") {
    add(
      /<(?:section|main|header|footer|form|nav|h1|h2|h3)\b[^>]*(?:id|class)=["']([^"']+)["']/gimu,
      "element",
    );
  } else {
    add(/^\s*(?:function|class|def)\s+([A-Za-z_$][\w$]*)/gmu, "declaration");
  }
  return { symbols, imports };
}

export function buildCodeOutline(
  source: string,
  extension: string,
  maxSymbols: number,
): CodeOutline {
  const parsed = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(
    extension,
  )
    ? parseJavaScriptOutline(source)
    : parsePatternOutline(source, extension);
  const uniqueSymbols = [
    ...new Map(
      parsed.symbols
        .sort(
          (left, right) =>
            left.line - right.line || left.name.localeCompare(right.name),
        )
        .map((symbol) => [
          `${symbol.kind}\0${symbol.name}\0${symbol.line}`,
          symbol,
        ]),
    ).values(),
  ];
  const uniqueImports = [...new Set(parsed.imports)].sort((left, right) =>
    left.localeCompare(right),
  );
  const selectedSymbols = uniqueSymbols.slice(0, maxSymbols);
  const selectedImports = uniqueImports.slice(0, IMPORT_LIMIT);
  const symbols = selectedSymbols.map((symbol) =>
    Object.freeze({
      ...symbol,
      name: boundLabel(symbol.name, SYMBOL_NAME_MAX_CHARS),
    }),
  );
  const imports = selectedImports.map((value) =>
    boundLabel(value, IMPORT_VALUE_MAX_CHARS),
  );
  return Object.freeze({
    symbols: Object.freeze(symbols),
    imports: Object.freeze(imports),
    metadata: Object.freeze({
      symbolsTruncated: uniqueSymbols.length > symbols.length,
      totalSymbols: uniqueSymbols.length,
      returnedSymbols: symbols.length,
      importsTruncated: uniqueImports.length > imports.length,
      totalImports: uniqueImports.length,
      returnedImports: imports.length,
      truncatedSymbolNames: selectedSymbols.filter(
        ({ name }) => name.length > SYMBOL_NAME_MAX_CHARS,
      ).length,
      truncatedImportValues: selectedImports.filter(
        (value) => value.length > IMPORT_VALUE_MAX_CHARS,
      ).length,
      symbolNameMaxChars: SYMBOL_NAME_MAX_CHARS,
      importValueMaxChars: IMPORT_VALUE_MAX_CHARS,
    }),
  });
}
