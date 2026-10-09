import { expect, test } from "vitest";
import {
  createWindowsCompanionStoreManifest,
  type WindowsCompanionStoreManifestOptions,
} from "../../../scripts/windows-companion-store-manifest.js";
import { WINDOWS_COMPANION_STORE } from "../../computer-access/companion/windows-store/identity.js";

const options: WindowsCompanionStoreManifestOptions = {
  version: [1, 6, 0, 0].join("."),
  architecture: "x64",
};

function attributes(xml: string, element: string) {
  const tags = [...xml.matchAll(new RegExp(`<${element}\\b([^>]*?)/?>`, "gu"))];
  return tags.map((tag) =>
    Object.fromEntries(
      [...tag[1]!.matchAll(/([\w:]+)="([^"]*)"/gu)].map((attribute) => [
        attribute[1],
        attribute[2],
      ]),
    ),
  );
}

test.each(["x64", "arm64"] as const)(
  "binds %s package to the single Store identity",
  (architecture) => {
    const xml = createWindowsCompanionStoreManifest({
      ...options,
      architecture,
    });
    expect(attributes(xml, "Identity")).toEqual([
      {
        Name: WINDOWS_COMPANION_STORE.name,
        Publisher: WINDOWS_COMPANION_STORE.publisher,
        Version: options.version,
        ProcessorArchitecture: architecture,
      },
    ]);
    expect(attributes(xml, "Application")).toEqual([
      {
        Id: WINDOWS_COMPANION_STORE.applicationId,
        Executable: "ABotCompanion.exe",
        "uap10:RuntimeBehavior": "packagedClassicApp",
        "uap10:TrustLevel": "mediumIL",
      },
    ]);
    expect(attributes(xml, "TargetDeviceFamily")).toEqual([
      {
        Name: "Windows.Desktop",
        MinVersion: "10.0.19041.0",
        MaxVersionTested: "10.0.26100.0",
      },
    ]);
  },
);

test("protocol activation passes exactly the quoted URL; only startup requests background mode", () => {
  const xml = createWindowsCompanionStoreManifest(options);
  expect(attributes(xml, "uap3:Protocol")).toEqual([
    {
      Name: WINDOWS_COMPANION_STORE.protocol.slice(0, -1),
      Parameters: "&quot;%1&quot;",
    },
    { Name: "abot", Parameters: "&quot;%1&quot;" },
  ]);
  expect(attributes(xml, "desktop:Extension")).toEqual([
    {
      Category: "windows.startupTask",
      Executable: "ABotCompanion.exe",
      EntryPoint: "Windows.FullTrustApplication",
      "uap10:Parameters": "--background",
    },
  ]);
  expect(attributes(xml, "desktop:StartupTask")).toEqual([
    {
      TaskId: "ABotCompanionStartup",
      Enabled: "true",
      DisplayName: WINDOWS_COMPANION_STORE.displayName,
    },
  ]);
  expect(attributes(xml, "rescap:Capability")).toEqual([
    { Name: "runFullTrust" },
  ]);
});

test("uses the packaged image paths and namespaces required by the manifest", () => {
  const xml = createWindowsCompanionStoreManifest(options);
  expect(xml).toContain("<Logo>Assets\\StoreLogo.png</Logo>");
  expect(attributes(xml, "uap:VisualElements")[0]).toMatchObject({
    Square44x44Logo: "Assets\\Square44x44Logo.png",
    Square150x150Logo: "Assets\\Square150x150Logo.png",
  });
  expect(attributes(xml, "Package")[0]).toMatchObject({
    "xmlns:uap3": "http://schemas.microsoft.com/appx/manifest/uap/windows10/3",
    "xmlns:uap10":
      "http://schemas.microsoft.com/appx/manifest/uap/windows10/10",
    "xmlns:desktop":
      "http://schemas.microsoft.com/appx/manifest/desktop/windows10",
  });
});

test.each([
  [0, 1, 0, 0].join("."),
  [1, 0, 0, 1].join("."),
  [65536, 0, 0, 0].join("."),
  [1, 65536, 0, 0].join("."),
  [1, 0, 65536, 0].join("."),
  [1, 0, 0].join("."),
  [1, 0, 0, 0, 0].join("."),
  [-1, 0, 0, 0].join("."),
  [1, 2, 3, 0].join(".") + '" injected="x',
  " " + [1, 0, 0, 0].join("."),
])("rejects a version unsuitable for Store submission: %s", (version) => {
  expect(() =>
    createWindowsCompanionStoreManifest({ ...options, version }),
  ).toThrow();
});

test("accepts the maximum Store component and refuses unsupported architectures", () => {
  const maximumVersion = [65535, 65535, 65535, 0].join(".");
  const xml = createWindowsCompanionStoreManifest({
    ...options,
    version: maximumVersion,
  });
  expect(attributes(xml, "Identity")[0]?.Version).toBe(maximumVersion);
  expect(() =>
    createWindowsCompanionStoreManifest({
      ...options,
      architecture:
        "neutral" as WindowsCompanionStoreManifestOptions["architecture"],
    }),
  ).toThrow("architecture");
});
