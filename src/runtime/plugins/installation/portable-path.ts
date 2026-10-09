/** Files and manifest-derived installation folders share the same portable naming rules. */
export function isPortablePluginPathComponent(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name)) return false;
  if (/[. ]$/u.test(name)) return false;
  return !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(
    name,
  );
}
