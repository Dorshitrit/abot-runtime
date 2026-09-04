import {
  parseWebSourceUrl,
  webSourceFaviconUrl,
} from "../lib/source-url-policy.js";

const PRESENTATION_LABELS = {
  content: { short: "Content", detail: "Content returned" },
  snippet: { short: "Snippet", detail: "Snippet returned" },
  reference: { short: "Link", detail: "Reference returned" },
  omitted: { short: "Omitted", detail: "Omitted from tool output" },
};

function sourceStatus(source) {
  if (source.presentation === "unknown") {
    const label = source.retrieval === "retrieved" ? "Fetched" : "Found";
    return { short: label, detail: label };
  }
  return PRESENTATION_LABELS[source.presentation] || { short: "", detail: "" };
}

function sourceDescription(source, url, status) {
  const details = [source.title, url.href, status.detail];
  if (source.retrieval === "failed") details.push("Fetch failed");
  if (source.contentTruncated) details.push("Partial content");
  const requested = parseWebSourceUrl(source.requestedUrl);
  if (requested && requested.href !== url.href) {
    details.push(`Requested: ${requested.href}`);
  }
  return details.filter(Boolean).join("\n");
}

function element(documentRoot, tag, className, text = "") {
  const node = documentRoot.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function sourceIcon(documentRoot, url) {
  const icon = element(documentRoot, "span", "conversation-source-icon");
  icon.setAttribute("aria-hidden", "true");
  const hostname = parseWebSourceUrl(url)?.hostname || "";
  const initial =
    hostname
      .replace(/^www\./u, "")
      .charAt(0)
      .toUpperCase() || "↗";
  const fallback = element(
    documentRoot,
    "span",
    "conversation-source-initial",
    initial,
  );
  icon.appendChild(fallback);
  const iconUrl = webSourceFaviconUrl(url);
  if (!iconUrl) return icon;
  const image = documentRoot.createElement("img");
  image.className = "conversation-source-favicon";
  image.alt = "";
  image.width = 16;
  image.height = 16;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", () => {
    fallback.hidden = true;
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    fallback.hidden = false;
  });
  image.src = iconUrl;
  icon.appendChild(image);
  return icon;
}

function sourceCard(documentRoot, source) {
  const url = parseWebSourceUrl(source.url);
  if (!url) return null;
  const item = element(documentRoot, "li", "conversation-source-card");
  const link = element(documentRoot, "a", "conversation-source-link");
  const status = sourceStatus(source);
  const description = sourceDescription(source, url, status);
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = description;
  link.setAttribute("aria-label", description);
  link.appendChild(sourceIcon(documentRoot, url.href));
  const domain = element(
    documentRoot,
    "span",
    "conversation-source-domain",
    url.hostname,
  );
  domain.dir = "ltr";
  link.appendChild(domain);
  const failed = source.retrieval === "failed";
  const label = failed ? `${status.short} · failed` : status.short;
  const badge = element(
    documentRoot,
    "span",
    "conversation-source-status",
    label,
  );
  badge.setAttribute("aria-hidden", "true");
  if (failed) badge.classList.add("is-failed");
  link.appendChild(badge);
  item.appendChild(link);
  return item;
}

export function createConversationSources({ documentRoot = document } = {}) {
  function createNode(groups = []) {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const section = element(documentRoot, "section", "conversation-sources");
    section.setAttribute("aria-label", "Web sources");
    const heading = element(
      documentRoot,
      "div",
      "conversation-sources-heading",
    );
    heading.appendChild(
      element(documentRoot, "h3", "conversation-sources-title", "Web sources"),
    );
    heading.title = "What the tools returned";
    section.appendChild(heading);

    groups.forEach((group, index) => {
      const block = element(documentRoot, "div", "conversation-sources-group");
      const header = element(
        documentRoot,
        "div",
        "conversation-sources-group-header",
      );
      const operation = group.operation === "fetch" ? "Fetch" : "Search";
      header.appendChild(
        element(
          documentRoot,
          "h4",
          "conversation-sources-operation",
          `${operation} · ${index + 1}`,
        ),
      );
      if (group.provider) {
        const provider = group.provider === "light" ? "Light" : "Brave";
        header.appendChild(
          element(
            documentRoot,
            "span",
            "conversation-sources-provider",
            provider,
          ),
        );
      }
      const list = element(documentRoot, "ol", "conversation-sources-list");
      for (const source of group.sources) {
        const card = sourceCard(documentRoot, source);
        if (card) list.appendChild(card);
      }
      block.append(header, list);
      if (group.omittedSourceCount > 0) {
        const notice = element(
          documentRoot,
          "p",
          "conversation-sources-omitted",
          `${group.omittedSourceCount} additional sources unavailable in this display`,
        );
        notice.title =
          "Source metadata exceeded the result size limit. Tool output was preserved.";
        notice.setAttribute(
          "aria-label",
          `${notice.textContent}. ${notice.title}`,
        );
        block.appendChild(notice);
      }
      section.appendChild(block);
    });
    return section;
  }
  return { createNode };
}
