const CHANGED_REASONS = new Set([
  "basket_source_changed", "basket_source_changed_during_read", "basket_source_changed_during_index",
]);
const CONFIGURATION_REASONS = new Set([
  "basket_embedding_profile_required", "basket_embedding_profile_unavailable",
  "basket_embedding_provider_unavailable", "basket_embedding_unavailable",
  "basket_embedding_binding_changed", "basket_embedding_binding_invalid",
  "basket_embedding_vector_invalid", "basket_embedding_vector_count_invalid",
]);
const LIMIT_REASONS = new Set([
  "basket_source_too_large", "basket_source_text_too_large", "basket_source_chunk_limit",
  "basket_pdf_resource_limit", "basket_pdf_input_too_large", "basket_pdf_page_limit",
  "basket_pdf_output_too_large",
]);
const TEXT_REASONS = new Set([
  "basket_source_binary_text", "basket_source_encoding_unsupported",
  "basket_source_no_extractable_text", "basket_pdf_content_invalid", "basket_pdf_protocol_invalid",
]);
const RETRYABLE_REASONS = new Set([
  "basket_index_failed", "basket_index_cancelled", "basket_index_timeout",
  "basket_pdf_timeout", "basket_pdf_process_unavailable", "basket_source_read_cancelled",
  "basket_source_unavailable",
]);
const ATTENTION_STATUSES = new Set(["stale", "missing", "failed", "unsupported"]);
const ACTION_LABELS = Object.freeze({ reindex: "Reindex", relink: "Relink file", settings: "Open settings", review: "Review source" });

function hasBasketAttentionIdentity(source) {
  if (!source || typeof source !== "object") return false;
  if (typeof source.sourceId !== "string" || !source.sourceId.trim()) return false;
  return Number.isSafeInteger(source.revision) && source.revision > 0;
}

function hasMissingBasketSource(source) {
  if (source.status === "missing") return true;
  if (source.reason === "basket_source_not_found") return true;
  return source.status === "stale" && source.reason === "basket_source_unavailable";
}

function attentionPresentation(source) {
  if (hasMissingBasketSource(source))
    return { title: "File unavailable", detail: "Choose the file again to restore its connection.", action: "relink" };
  if (CHANGED_REASONS.has(source.reason))
    return { title: "Source changed", detail: "Reindex to make the latest contents available.", action: "reindex" };
  if (CONFIGURATION_REASONS.has(source.reason))
    return { title: "Embedding needs attention", detail: "Check the embedding profile and provider in Resources settings.", action: "settings" };
  if (source.status === "unsupported" || source.reason === "basket_source_format_unsupported")
    return { title: "Unsupported format", detail: "Review the source and choose a supported file format.", action: "review" };
  if (LIMIT_REASONS.has(source.reason))
    return { title: "Source exceeds a limit", detail: "Review the source size or split it into smaller files.", action: "review" };
  if (TEXT_REASONS.has(source.reason))
    return { title: "Text could not be read", detail: "Review the file format and whether its text can be extracted.", action: "review" };
  if (source.reason === "basket_source_unreadable")
    return { title: "File access needs attention", detail: "Review the file access permissions before indexing again.", action: "review" };
  if (source.status === "failed" && RETRYABLE_REASONS.has(source.reason))
    return { title: "Indexing did not finish", detail: "Check that the source is available, then retry indexing.", action: "reindex" };
  return { title: "Source needs review", detail: "Open Resources to review this source and its indexing status.", action: "review" };
}

function attentionDisplayName(value) {
  if (typeof value !== "string") return "Unnamed source";
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return "Unnamed source";
  return Array.from(text).slice(0, 180).join("");
}

function basketReindexConfigurationDetail(view) {
  const settings = view?.settings;
  if (!settings || typeof settings !== "object") return "";
  if (settings.enabled === false)
    return "Resources is turned off. Open settings before reindexing this source.";
  const profileId = settings.embeddingProfileId;
  if (typeof profileId !== "string" || !profileId.trim())
    return "Choose an embedding profile in Resources settings before reindexing.";
  if (!Array.isArray(view.embeddingProfiles)) return "";
  if (view.embeddingProfiles.some(profile => profile?.id === profileId)) return "";
  return "The selected embedding profile is unavailable. Choose an available profile in Resources settings.";
}

function resolveBasketAttentionAction(source, view) {
  const presentation = attentionPresentation(source);
  if (presentation.action !== "reindex") return presentation;
  const detail = basketReindexConfigurationDetail(view);
  if (!detail) return presentation;
  return { ...presentation, detail, action: "settings" };
}

/** Present only existing source problems; this projection never reads files or infers freshness. */
export function projectBasketAttention(view) {
  if (!Array.isArray(view?.sources)) return [];
  const issues = [];
  const seen = new Set();
  for (const source of view.sources) {
    if (!hasBasketAttentionIdentity(source)) continue;
    if (!ATTENTION_STATUSES.has(source.status) || seen.has(source.sourceId)) continue;
    seen.add(source.sourceId);
    const presentation = resolveBasketAttentionAction(source, view);
    issues.push({ sourceId: source.sourceId, revision: source.revision,
      displayName: attentionDisplayName(source.displayName), status: source.status,
      ...presentation, label: ACTION_LABELS[presentation.action] });
  }
  return issues;
}
