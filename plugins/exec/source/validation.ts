import type { ToolCallAdapter } from "../../../src/plugin-sdk/index.js";

const INVALID_COMMAND_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu;

const INTERACTIVE_COMMANDS = new Set([
  "gio",
  "gnome-open",
  "htop",
  "kde-open",
  "less",
  "more",
  "nano",
  "open",
  "screen",
  "ssh",
  "start",
  "tmux",
  "top",
  "vi",
  "vim",
  "watch",
  "xdg-open",
]);

export function sanitizeExecCommand(value: string): Readonly<{
  command: string;
  normalized: boolean;
}> {
  const raw = value.trim();
  const command = raw
    .replace(/\r\n?/gu, "\n")
    .replace(INVALID_COMMAND_CHARS, "")
    .trim();
  return Object.freeze({ command, normalized: command !== raw });
}

export function isInteractiveCommand(command: string): string | undefined {
  const firstToken = command.split(/\s+/u)[0]?.toLowerCase() ?? "";
  return INTERACTIVE_COMMANDS.has(firstToken) ? firstToken : undefined;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r";
}

function isShellSeparator(char: string): boolean {
  return ["\n", ";", "|", "&", "<", ">"].includes(char);
}

function isShellTokenBoundary(char: string): boolean {
  return (
    isWhitespace(char) || isShellSeparator(char) || char === "(" || char === ")"
  );
}

function readShellTokenSpan(
  command: string,
  start: number,
): Readonly<{ token: string; nextIndex: number }> {
  let index = start;
  let token = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let substitutionDepth = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (!inSingleQuote && !inDoubleQuote) {
      if (substitutionDepth === 0 && isShellTokenBoundary(char)) break;
      if (char === "$" && command[index + 1] === "(") {
        token += "$(";
        substitutionDepth += 1;
        index += 2;
        continue;
      }
      if (char === ")" && substitutionDepth > 0) {
        token += char;
        substitutionDepth -= 1;
        index += 1;
        continue;
      }
      if (char === "\\") {
        index += 1;
        if (index < command.length) {
          token += command[index];
          index += 1;
        }
        continue;
      }
      if (char === "'") {
        inSingleQuote = true;
        index += 1;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        index += 1;
        continue;
      }
      token += char;
      index += 1;
      continue;
    }
    index += 1;
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      else token += char;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = false;
      continue;
    }
    if (char === "\\" && index < command.length) {
      token += command[index];
      index += 1;
      continue;
    }
    token += char;
  }
  return Object.freeze({ token: token.trim(), nextIndex: index });
}

function readShellToken(
  command: string,
  start: number,
): Readonly<{ token: string; nextIndex: number }> {
  let index = start;
  while (index < command.length && isWhitespace(command[index] ?? "")) {
    index += 1;
  }
  return readShellTokenSpan(command, index);
}

function readHereDocDelimiters(
  line: string,
): readonly Readonly<{ delimiter: string; stripTabs: boolean }>[] {
  const delimiters: Array<{ delimiter: string; stripTabs: boolean }> = [];
  const pattern = /<<(-)?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/gu;
  for (const match of line.matchAll(pattern)) {
    const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
    if (delimiter) {
      delimiters.push({ delimiter, stripTabs: Boolean(match[1]) });
    }
  }
  return delimiters;
}

export function stripHereDocBodies(command: string): string {
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  return command
    .split("\n")
    .map((line) => {
      const active = pending[0];
      if (active) {
        const comparable = active.stripTabs ? line.replace(/^\t+/u, "") : line;
        if (comparable === active.delimiter) {
          pending.shift();
          return line;
        }
        return "";
      }
      pending.push(...readHereDocDelimiters(line));
      return line;
    })
    .join("\n");
}

export function scopedPathTokens(command: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (
      index < command.length &&
      isShellTokenBoundary(command[index] ?? "")
    ) {
      index += 1;
    }
    if (index >= command.length) break;
    const span = readShellToken(command, index);
    index = Math.max(span.nextIndex, index + 1);
    const token = span.token;
    if (
      token === "." ||
      token === ".." ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      token === "workspace" ||
      token.startsWith("workspace/") ||
      token.startsWith("workspace\\") ||
      token.startsWith("/")
    ) {
      tokens.push(token);
    }
  }
  return Object.freeze(tokens);
}

export function createExecAdapter(): ToolCallAdapter {
  return {
    validateCall(input) {
      const invalid = ["command", "cwd"].filter((name) => {
        const value = input.params[name];
        return typeof value !== "string" || value.trim().length === 0;
      });
      if (invalid.length === 0) return null;
      return {
        error: `invalid params for exec: invalid ${invalid.join(", ")}`,
        repairHint:
          "Provide one non-interactive command and one explicit existing agent-work or workspace cwd.",
      };
    },
  };
}
