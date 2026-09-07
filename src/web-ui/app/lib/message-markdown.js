import MarkdownIt from "../vendor/markdown-it.js";
import { safeLinkHref } from "./message-url-policy.js";
import { parseWebSourceUrl } from "./source-url-policy.js";

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});

markdown.linkify.set({ fuzzyLink: true });

// Leave parsing to the Markdown grammar, then apply the stricter display
// policy. Rejecting a valid Markdown token during parsing can make linkify
// reinterpret only a fragment of its destination as an unrelated URL.
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!safeLinkHref(token.attrGet("href"))) {
    const closing = tokens
      .slice(index + 1)
      .find((item) => item.type === "link_close");
    if (closing) closing.hidden = true;
    return "";
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.table_open = () =>
  '<div class="markdown-table-scroll" role="region" aria-label="Message table" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

function isImageInsideLink(tokens, index) {
  const boundary = tokens
    .slice(0, index)
    .findLast(
      (token) => token.type === "link_open" || token.type === "link_close",
    );
  return boundary?.type === "link_open";
}

// Remote images use the bounded preview path too: rendering a message must
// never issue an unchecked image request to an arbitrary host.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const label = markdown.utils.escapeHtml(token.content || "Image");
  if (isImageInsideLink(tokens, index)) return label;
  const href = safeLinkHref(token.attrGet("src"));
  if (!href) return label;
  return `<a href="${markdown.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
};

function messageSource(raw) {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

export function renderMarkdown(raw) {
  return markdown.render(messageSource(raw));
}

function inlineLinkLabel(tokens, start) {
  const label = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "link_close") break;
    if (token.content) label.push(token.content);
  }
  return label.join("");
}

export function extractMessageLinks(raw) {
  const links = [];
  const seen = new Set();
  const blocks = markdown.parse(messageSource(raw), {});
  for (const block of blocks) {
    if (block.type !== "inline") continue;
    const tokens = block.children || [];
    for (const [index, token] of tokens.entries()) {
      const isImage = token.type === "image";
      if (token.type !== "link_open" && !isImage) continue;
      if (isImage && isImageInsideLink(tokens, index)) continue;
      const url = parseWebSourceUrl(token.attrGet(isImage ? "src" : "href"));
      if (!url) continue;
      const key = new URL(url.href);
      key.hash = "";
      if (seen.has(key.href)) continue;
      seen.add(key.href);
      links.push({
        url: url.href,
        label: isImage ? token.content : inlineLinkLabel(tokens, index),
      });
      if (links.length === 3) return links;
    }
  }
  return links;
}
