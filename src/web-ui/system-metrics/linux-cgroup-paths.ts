import { posix } from "node:path";
import type { ReadSystemText } from "./system-files.js";

export type CgroupDirectory = Readonly<{ version: 1 | 2; directory: string; mount: string }>;
export type CgroupLocations = Readonly<{
  cpu: CgroupDirectory | null;
  accounting: CgroupDirectory | null;
  memory: CgroupDirectory | null;
  cpuset: CgroupDirectory | null;
}>;

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function resolveCgroupDirectory(root: string, mount: string, membership: string,
  version: 1 | 2): CgroupDirectory | null {
  if (!mount.startsWith("/sys/")) return null;
  // In a private cgroup namespace / names the mount's root, not the physical host's root.
  const relative = membership === "/" ? "" : posix.relative(root, membership);
  if (relative === ".." || relative.startsWith("../")) return null;
  const directory = posix.resolve(mount, relative);
  if (directory !== mount && !directory.startsWith(`${mount}/`)) return null;
  return { version, directory, mount };
}

export async function findCgroupLocations(read: ReadSystemText): Promise<CgroupLocations | null> {
  const [memberships, mountinfo] = await Promise.all([read("/proc/self/cgroup"), read("/proc/self/mountinfo")]);
  if (!memberships || !mountinfo) return null;
  const groups = memberships.split("\n").flatMap(line => {
    const [hierarchy, controllers, ...path] = line.split(":");
    if (controllers === undefined || !path.join(":").startsWith("/")) return [];
    return [{ hierarchy, controllers: controllers.split(","), path: path.join(":") }];
  });
  const mounts = mountinfo.split("\n").flatMap(line => {
    const [left, right] = line.split(" - ");
    if (!left || !right) return [];
    const fields = left.split(" "); const [type, , options = ""] = right.split(" ");
    if (type !== "cgroup" && type !== "cgroup2") return [];
    if (!fields[3] || !fields[4]) return [];
    return [{ type, root: decodeMountPath(fields[3]), mount: decodeMountPath(fields[4]), controllers: options.split(",") }];
  });
  const unified = groups.find(group => group.hierarchy === "0" && group.controllers[0] === "");
  const unifiedMount = mounts.find(mount => mount.type === "cgroup2");
  const unifiedLocation = unified && unifiedMount
    ? resolveCgroupDirectory(unifiedMount.root, unifiedMount.mount, unified.path, 2) : null;
  function locateController(controller: string): CgroupDirectory | null {
    const group = groups.find(value => value.controllers.includes(controller));
    // A controller bound to v1 cannot also serve this metric in the unified hierarchy.
    if (!group) return unifiedLocation;
    const mount = mounts.find(value => value.type === "cgroup" && value.controllers.includes(controller));
    if (!mount) return null;
    return resolveCgroupDirectory(mount.root, mount.mount, group.path, 1);
  }
  const result = { cpu: locateController("cpu"), accounting: locateController("cpuacct"),
    memory: locateController("memory"), cpuset: locateController("cpuset") };
  if (!result.cpu && !result.accounting && !result.memory) return null;
  return result;
}

/** Inspect only visible ancestors; never escape a namespaced cgroup mount. */
export function cgroupAncestors(location: CgroupDirectory | null): string[] {
  if (!location) return [];
  const paths: string[] = [];
  let current = location.directory;
  for (let depth = 0; depth < 32; depth += 1) {
    paths.push(current);
    if (current === location.mount) break;
    current = posix.dirname(current);
  }
  return paths;
}
