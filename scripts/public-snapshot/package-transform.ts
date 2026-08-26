import {
  PUBLIC_PACKAGE_FILES,
  PUBLIC_PACKAGE_SCRIPT_OVERRIDES,
  PUBLIC_PACKAGE_SCRIPT_NAMES,
  PUBLIC_PLUGIN_IDS,
} from "./contracts.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readPackageIdentity(
  value: unknown,
  label: string,
): Readonly<{ name: string; version: string }> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must contain a plain object`);
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new Error(`${label}.version must be a non-empty string`);
  }
  return Object.freeze({ name: value.name, version: value.version });
}

export function assertPrivateSourcePackageJson(value: unknown): void {
  if (!isPlainRecord(value) || value.private !== true) {
    throw new Error("source package.json must declare private=true");
  }
}

export function transformPublicPackageJson(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new Error("package.json must contain a plain object");
  }
  if (!isPlainRecord(value.scripts)) {
    throw new Error("package.json scripts must contain a plain object");
  }
  if (value.private !== true && value.private !== false) {
    throw new Error(
      "package.json must explicitly declare private=true or false",
    );
  }
  const sourceScripts = value.scripts;
  const scripts = Object.fromEntries(
    PUBLIC_PACKAGE_SCRIPT_NAMES.map((scriptName) => {
      const override =
        PUBLIC_PACKAGE_SCRIPT_OVERRIDES[
          scriptName as keyof typeof PUBLIC_PACKAGE_SCRIPT_OVERRIDES
        ];
      if (override !== undefined) {
        return [scriptName, override];
      }
      const command = sourceScripts[scriptName];
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error(`package.json is missing public script: ${scriptName}`);
      }
      return [scriptName, command];
    }),
  );

  return Object.freeze({
    ...value,
    private: false,
    scripts: Object.freeze(scripts),
    files: Object.freeze([...PUBLIC_PACKAGE_FILES]),
  });
}

export function assertPrivateSourcePackageLock(
  value: unknown,
  packageJson: unknown,
): void {
  const transformed = transformPublicPackageLock(value, packageJson);
  const source = value as Record<string, unknown>;
  const packages = source.packages as Record<string, unknown>;
  const rootPackage = packages[""] as Record<string, unknown>;
  if (rootPackage.private !== true) {
    throw new Error(
      "source package-lock.json root package must declare private=true",
    );
  }
  void transformed;
}

export function transformPublicPackageLock(
  value: unknown,
  packageJson: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new Error("package-lock.json must contain a plain object");
  }
  if (!isPlainRecord(value.packages)) {
    throw new Error("package-lock.json.packages must contain a plain object");
  }
  const rootPackage = value.packages[""];
  if (!isPlainRecord(rootPackage)) {
    throw new Error(
      'package-lock.json.packages[""] must contain a plain object',
    );
  }
  if (rootPackage.private !== true && rootPackage.private !== false) {
    throw new Error(
      'package-lock.json.packages[""].private must explicitly declare true or false',
    );
  }
  const packageIdentity = readPackageIdentity(packageJson, "package.json");
  const lockIdentity = readPackageIdentity(value, "package-lock.json");
  const rootIdentity = readPackageIdentity(
    rootPackage,
    'package-lock.json.packages[""]',
  );
  for (const [label, identity] of [
    ["package-lock.json", lockIdentity],
    ['package-lock.json.packages[""]', rootIdentity],
  ] as const) {
    if (
      identity.name !== packageIdentity.name ||
      identity.version !== packageIdentity.version
    ) {
      throw new Error(
        `${label} name/version must match package.json (${packageIdentity.name}@${packageIdentity.version})`,
      );
    }
  }

  return Object.freeze({
    ...value,
    packages: Object.freeze({
      ...value.packages,
      "": Object.freeze({
        ...rootPackage,
        private: false,
      }),
    }),
  });
}

export function assertExactPublicPluginPackagePaths(
  paths: readonly string[],
): void {
  const packagedPluginIds = [
    ...new Set(
      paths.flatMap((path) => {
        const match = /^plugins\/([^/]+)\//.exec(path);
        return match?.[1] ? [match[1]] : [];
      }),
    ),
  ].sort();
  const expectedPluginIds = [...PUBLIC_PLUGIN_IDS].sort();
  if (
    packagedPluginIds.length !== expectedPluginIds.length ||
    packagedPluginIds.some(
      (pluginId, index) => pluginId !== expectedPluginIds[index],
    )
  ) {
    throw new Error(
      `public package must include exactly the approved plugin set; expected ${expectedPluginIds.join(", ")}; received ${packagedPluginIds.join(", ")}`,
    );
  }
}
