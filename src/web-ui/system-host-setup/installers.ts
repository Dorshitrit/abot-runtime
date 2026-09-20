import JSZip from "jszip";
import {
  validateCompanionInstaller,
  validateWslDistribution,
  type CompanionInstallerInput,
  type InstallerDownload,
} from "./installer-contract.js";
import { renderWindowsCompanionScript } from "./companion-windows.js";
import { renderMacCompanionScript } from "./companion-macos.js";
import { renderWindowsWslInteropScript } from "./wsl-interop-windows.js";

export { InstallerInputError } from "./installer-contract.js";

export async function renderCompanionInstaller(raw: CompanionInstallerInput): Promise<InstallerDownload> {
  const input = validateCompanionInstaller(raw);
  if (input.platform === "windows") return {
    filename: "ABot-Connect-Computer.cmd",
    mimeType: "application/octet-stream",
    contentBase64: Buffer.from(renderWindowsCompanionScript(input), "utf8").toString("base64"),
  };
  const zip = new JSZip();
  zip.file("ABot-Connect-Computer.command", renderMacCompanionScript(input), { unixPermissions: 0o100755 });
  return {
    filename: "ABot-Connect-Computer-macOS.zip",
    mimeType: "application/zip",
    contentBase64: await zip.generateAsync({ type: "base64", platform: "UNIX", compression: "DEFLATE" }),
  };
}

export async function renderWslInteropInstaller(input: Readonly<{ distribution?: string }>): Promise<InstallerDownload> {
  const distribution = validateWslDistribution(input.distribution);
  return {
    filename: "ABot-Enable-WSL-Interop.cmd",
    mimeType: "application/octet-stream",
    contentBase64: Buffer.from(renderWindowsWslInteropScript(distribution), "utf8").toString("base64"),
  };
}
