export function embeddingProviderOptions(providers) {
  const choices = providers.map((provider) => ({
    id: provider.id,
    label: `${provider.id} · ${provider.type}`,
  }));
  const labels = { openai: "OpenAI", ollama: "Ollama", llamacpp: "llama.cpp" };
  for (const type of Object.keys(labels)) {
    if (
      type !== "llamacpp" &&
      providers.some((provider) => provider.type === type)
    )
      continue;
    choices.push({
      id: `new:${type}`,
      label: `${labels[type]} · new connection`,
    });
  }
  return choices;
}

export function isNewEmbeddingProviderChoice(choice, providers) {
  return embeddingProviderOptions(providers).some(
    (option) => option.id === choice && choice.startsWith("new:"),
  );
}

export function suggestEmbeddingConnectionId(providers) {
  const occupied = new Set(providers.map((provider) => provider.id));
  let id = "llamacpp-embedding";
  for (let suffix = 2; occupied.has(id); suffix += 1)
    id = `llamacpp-embedding-${suffix}`;
  return id;
}

export function isValidEmbeddingConnectionId(id) {
  return (
    typeof id === "string" &&
    id.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(id) &&
    !["__proto__", "prototype", "constructor"].includes(id)
  );
}

export function embeddingProviderHasAddress(type) {
  return type === "ollama" || type === "llamacpp";
}

export function embeddingProviderAcceptsCredential(type, provider) {
  if (type === "openai") return true;
  if (type !== "llamacpp") return false;
  if (!provider) return true;
  if (provider.credentialConfigured === true) return true;
  return provider.requiresApiKey !== false;
}
