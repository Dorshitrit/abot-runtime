import { WINDOWS_COMPANION_STORE } from "../src/computer-access/companion/windows-store/identity.js";

export type WindowsCompanionStoreManifestOptions = Readonly<{
  version: string;
  architecture: "x64" | "arm64";
}>;

function storePackageVersion(value: string): string {
  if (!/^\d{1,5}(?:\.\d{1,5}){3}$/u.test(value))
    throw new Error(
      "Store package version must contain four numeric components.",
    );
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 65_535))
    throw new Error("Store package version components must not exceed 65535.");
  if (parts[0] === 0)
    throw new Error("Store package major version must be greater than zero.");
  if (parts[3] !== 0)
    throw new Error("The fourth Store package version component must be zero.");
  return parts.join(".");
}

function xmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function protocolExtension(protocol: string): string {
  return `        <uap3:Extension Category="windows.protocol">
          <uap3:Protocol Name="${xmlAttribute(protocol)}" Parameters="&quot;%1&quot;" />
        </uap3:Extension>`;
}

/** Windows owns package registration; Node continues to own Companion state. */
export function createWindowsCompanionStoreManifest(
  options: WindowsCompanionStoreManifestOptions,
): string {
  const version = storePackageVersion(options.version);
  if (options.architecture !== "x64" && options.architecture !== "arm64")
    throw new Error("Store package architecture must be x64 or arm64.");
  const identity = WINDOWS_COMPANION_STORE;
  const protocols = [identity.protocol.replace(/:$/u, ""), "abot"];
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 uap10 desktop rescap">
  <Identity Name="${xmlAttribute(identity.name)}" Publisher="${xmlAttribute(identity.publisher)}"
    Version="${version}" ProcessorArchitecture="${options.architecture}" />
  <Properties>
    <DisplayName>${xmlAttribute(identity.displayName)}</DisplayName>
    <PublisherDisplayName>${xmlAttribute(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>Connect this computer to your ABot runtime.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="${xmlAttribute(identity.applicationId)}" Executable="ABotCompanion.exe"
      uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="${xmlAttribute(identity.displayName)}"
        Description="Connect this computer to your ABot runtime."
        Square44x44Logo="Assets\\Square44x44Logo.png"
        Square150x150Logo="Assets\\Square150x150Logo.png" BackgroundColor="#071011" />
      <Extensions>
${protocols.map(protocolExtension).join("\n")}
        <desktop:Extension Category="windows.startupTask" Executable="ABotCompanion.exe" EntryPoint="Windows.FullTrustApplication"
          uap10:Parameters="--background">
          <desktop:StartupTask TaskId="ABotCompanionStartup" Enabled="true"
            DisplayName="${xmlAttribute(identity.displayName)}" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}
