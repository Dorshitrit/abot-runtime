export function textOf(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function shortId(id) {
  const value = textOf(id);
  return value.length > 12
    ? `${value.slice(0, 6)}...${value.slice(-4)}`
    : value;
}

export function formatTime(value) {
  if (!value) return "";
  const date =
    typeof value === "number"
      ? new Date(value)
      : /^\d+$/.test(String(value))
        ? new Date(Number(value))
        : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function hasRtlText(value) {
  return /[\u0590-\u08ff]/.test(textOf(value));
}

export function applyTextDirection(element, value) {
  const isRtl = hasRtlText(value);
  element.dir = isRtl ? "rtl" : "auto";
  element.classList.toggle("rtl-text", isRtl);
}

export function createWebSessionId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `abot-web-${Date.now()}-${random}`;
}

export function escapeHtml(value) {
  return textOf(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

export function safeLinkHref(value, baseHref = globalThis.location?.href) {
  try {
    const url = new URL(value, baseHref);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      return url.href;
    }
  } catch {
    return "";
  }
  return "";
}

function renderInlineMarkdown(raw) {
  let text = escapeHtml(raw);
  const codeTokens = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safeHref = safeLinkHref(href);
    if (!safeHref) return label;
    return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  for (let index = 0; index < codeTokens.length; index += 1) {
    text = text.replaceAll(`@@CODE${index}@@`, codeTokens[index]);
  }
  return text;
}

export function renderMarkdown(raw) {
  const source = textOf(raw);
  if (!source.trim()) return "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let quote = [];
  let code = [];
  let inCode = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push(
      `<p>${paragraph.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`,
    );
    paragraph = [];
  }

  function flushList() {
    if (list.length === 0) return;
    blocks.push(
      `<ul>${list
        .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
        .join("")}</ul>`,
    );
    list = [];
  }

  function flushQuote() {
    if (quote.length === 0) return;
    blocks.push(
      `<blockquote>${quote
        .map((line) => renderInlineMarkdown(line))
        .join("<br>")}</blockquote>`,
    );
    quote = [];
  }

  function flushCode() {
    if (code.length === 0) return;
    blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = [];
  }

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.]\s+(.+)$/);
    const quoted = line.match(/^>\s?(.+)$/);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      list.push((bullet || numbered)[1]);
      continue;
    }
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();
  return blocks.join("");
}
