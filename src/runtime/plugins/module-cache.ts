import { createRequire } from "node:module";
import { isAbsolute, relative, sep } from "node:path";

const require = createRequire(import.meta.url);

/** Retire only this installation's CommonJS graph, including package-local helpers. */
export function evictPluginModules(pluginRoot: string): void {
  const removed = new Set<NodeJS.Module>();
  for (const [path, module] of Object.entries(require.cache)) {
    const child = relative(pluginRoot, path);
    const outside =
      isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`);
    if (outside || !module) continue;
    removed.add(module);
    delete require.cache[path];
  }
  for (const module of Object.values(require.cache)) {
    if (module)
      module.children = module.children.filter((child) => !removed.has(child));
  }
}
