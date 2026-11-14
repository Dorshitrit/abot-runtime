export function isComposerCommand(text) {
  return /^\/\s*(?:[a-z][a-z0-9_-]*(?:\s[\s\S]*)?)?$/i.test(text.trim());
}

export function resolveComposerCommand(text, definitions, activeRequestId) {
  const match = /^\/\s*([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) throw new Error("Choose a command first.");
  const definition = definitions.find(
    (entry) => entry.name === match[1].toLowerCase(),
  );
  if (!definition) throw new Error(`Unknown command: /${match[1]}`);
  const mode = activeRequestId ? "steer" : "run";
  if (!definition.modes.includes(mode))
    throw new Error(`/${definition.name} is available between runs only.`);
  if (match[2]?.trim())
    throw new Error(`/${definition.name} does not accept arguments.`);
  return {
    name: definition.name,
    mode,
    ...(mode === "steer" ? { targetRequestId: activeRequestId } : {}),
  };
}

export function matchingComposerCommands(text, definitions) {
  const match = /^\/\s*([a-z0-9_-]*)$/i.exec(text.trim());
  if (!match) return [];
  const query = match[1].toLowerCase();
  return definitions
    .filter(({ name, description }) =>
      `${name} ${description}`.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(right.name.startsWith(query)) -
          Number(left.name.startsWith(query)) ||
        left.name.localeCompare(right.name),
    );
}
