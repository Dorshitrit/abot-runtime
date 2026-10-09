/** Matches the existing wildcard, owner, tool, and qualified tool selectors. */
export function matchesToolSelectionId(
  ownerId: string,
  toolName: string,
  configuredId: string,
): boolean {
  return (
    configuredId === "*" ||
    configuredId === ownerId ||
    configuredId === toolName ||
    configuredId === `${ownerId}.${toolName}`
  );
}
