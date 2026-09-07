import { extractMessageLinks } from "../lib/message-markdown.js";
import { parseWebSourceUrl } from "../lib/source-url-policy.js";
import { createMessageLinkPreviewClient } from "../services/message-link-preview-client.js";

function previewElement(documentRoot, tag, className, text = "") {
  const node = documentRoot.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function previewText(value, limit) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function sameOriginPreviewImage(value, baseHref) {
  if (typeof value !== "string" || !value || !baseHref) return "";
  try {
    const base = new URL(baseHref);
    const image = new URL(value, base);
    if (image.protocol !== "http:" && image.protocol !== "https:") return "";
    if (image.origin !== base.origin) return "";
    if (image.username || image.password) return "";
    if (image.pathname !== "/web-link-preview/image") return "";
    if (!/^[a-f\d-]{36}$/iu.test(image.searchParams.get("id") || "")) return "";
    return image.href;
  } catch {
    return "";
  }
}

function createPreviewCard(documentRoot, link) {
  const url = parseWebSourceUrl(link.url);
  if (!url) return null;
  const card = previewElement(documentRoot, "a", "message-link-preview");
  card.href = url.href;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  const image = previewElement(
    documentRoot,
    "img",
    "message-link-preview-image",
  );
  image.hidden = true;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "same-origin";
  image.addEventListener("error", () => {
    image.hidden = true;
  });
  const content = previewElement(
    documentRoot,
    "span",
    "message-link-preview-content",
  );
  const domain = previewElement(
    documentRoot,
    "span",
    "message-link-preview-domain",
    url.hostname,
  );
  domain.dir = "ltr";
  const label = link.label === link.url ? url.hostname : link.label;
  const title = previewElement(
    documentRoot,
    "span",
    "message-link-preview-title",
    label || url.hostname,
  );
  title.dir = "auto";
  card.title = `${title.textContent}\n${url.href}`;
  card.setAttribute("aria-label", card.title);
  content.append(domain, title);
  card.append(image, content);
  return { card, image, title, url: url.href };
}

function applyPreviewMetadata(card, preview, baseHref) {
  if (!preview) return;
  const title = previewText(preview.title, 300);
  if (title) card.title.textContent = title;
  const description = previewText(preview.description, 500);
  card.card.title = [card.title.textContent, description, card.url]
    .filter(Boolean)
    .join("\n");
  card.card.setAttribute("aria-label", card.card.title);
  const imageUrl = sameOriginPreviewImage(preview.imageUrl, baseHref);
  if (!imageUrl) return;
  card.image.src = imageUrl;
  card.image.hidden = false;
}

export function createMessageLinkPreviews({
  documentRoot = document,
  viewport = window,
  scrollRoot = null,
  onLayoutChange = () => {},
  client = createMessageLinkPreviewClient({
    fetchImpl: viewport.fetch?.bind(viewport) ?? null,
  }),
} = {}) {
  let observer = null;
  let renderVersion = 0;
  const observedCards = new Map();

  function notifyCurrentLayout(version) {
    if (version !== renderVersion) return;
    onLayoutChange();
  }

  function hydrateCard(card, version) {
    void client.get(card.url).then((preview) => {
      if (version !== renderVersion) return;
      applyPreviewMetadata(card, preview, documentRoot.baseURI);
      if (preview) notifyCurrentLayout(version);
    });
  }

  function reset() {
    renderVersion += 1;
    observer?.disconnect();
    observer = null;
    observedCards.clear();
    client.cancelQueued();
  }

  function ensureObserver() {
    if (observer) return observer;
    if (typeof viewport.IntersectionObserver !== "function") return null;
    const version = renderVersion;
    observer = new viewport.IntersectionObserver(
      (entries) => {
        if (version !== renderVersion) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = observedCards.get(entry.target);
          if (!card) continue;
          observedCards.delete(entry.target);
          observer.unobserve(entry.target);
          hydrateCard(card, version);
        }
      },
      { root: scrollRoot, rootMargin: "240px" },
    );
    return observer;
  }

  function createNode(message) {
    if (message?.streaming) return null;
    const links = extractMessageLinks(message?.text);
    if (links.length === 0) return null;
    const container = previewElement(
      documentRoot,
      "div",
      "message-link-previews",
    );
    container.setAttribute("aria-label", "Link previews");
    for (const link of links) {
      const card = createPreviewCard(documentRoot, link);
      if (!card) continue;
      container.appendChild(card.card);
      const version = renderVersion;
      card.image.addEventListener("load", () => notifyCurrentLayout(version));
      card.image.addEventListener("error", () => notifyCurrentLayout(version));
      const intersectionObserver = ensureObserver();
      if (intersectionObserver) {
        observedCards.set(card.card, card);
        intersectionObserver.observe(card.card);
        continue;
      }
      hydrateCard(card, renderVersion);
    }
    return container;
  }

  return { createNode, reset };
}
