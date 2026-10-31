type OllamaModelCatalogOptions = {
  baseUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/** Reads installed model names only. It never generates output or downloads a model. */
export async function inspectOllamaModelCatalog(options: OllamaModelCatalogOptions): Promise<string[]> {
  const timeout = AbortSignal.timeout(1500);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/$/u, "")}/api/tags`, { signal });
  if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status}).`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models))
    throw new Error("Ollama returned an invalid model catalog.");
  return [...new Set(body.models.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("name" in entry)) return [];
    if (typeof entry.name !== "string" || !entry.name.trim()) return [];
    return [entry.name.trim()];
  }))];
}

function modelWithDefaultTag(model: string): string {
  const name = model.slice(model.lastIndexOf("/") + 1);
  return name.includes(":") ? model : `${model}:latest`;
}

export function hasInstalledOllamaModel(models: readonly string[], model: string): boolean {
  return models.some((candidate) => modelWithDefaultTag(candidate) === modelWithDefaultTag(model));
}
