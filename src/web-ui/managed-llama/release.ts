import { requireValue, type Release } from "./contracts.js";

/** Pinned upstream metadata; runtime compatibility has not yet been assessed. */
export const RELEASES = Object.freeze({
  arm64: Object.freeze({
    tag: "b12608",
    name: "llama-b12608-bin-macos-arm64.tar.gz",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12608/llama-b12608-bin-macos-arm64.tar.gz",
    size: 16576422,
    sha256: "8c1909d59cf2bbe9c973df786fcf7505c13bcb0d3eb33e8d957bd0f78f805090",
  } satisfies Release),
  x64: Object.freeze({
    tag: "b12608",
    name: "llama-b12608-bin-macos-x64.tar.gz",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12608/llama-b12608-bin-macos-x64.tar.gz",
    size: 12362265,
    sha256: "e02a20d09d4e57c5bc68a0fdc170ce3d835ecb082d24934576587e9d7d93163b",
  } satisfies Release),
});

const CPU_RELEASES: Readonly<Record<string, Release>> = Object.freeze({
  "linux-x64": Object.freeze({
    tag: "b12608", name: "llama-b12608-bin-ubuntu-x64.tar.gz",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12608/llama-b12608-bin-ubuntu-x64.tar.gz",
    size: 23185237, sha256: "437a78088609f8faac6eddb8654614a0bafd761d3e9803b304c1b623074f599c",
  }),
  "win32-x64": Object.freeze({
    tag: "b12608", name: "llama-b12608-bin-win-cpu-x64.zip",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12608/llama-b12608-bin-win-cpu-x64.zip",
    size: 25009019, sha256: "7f83ea573f23eb3233ccea0ef4dbcb6eb84aec4b558034e39f08270989f4c3c6",
  }),
});
export const SUPPORTED_PLATFORMS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);

export function selectRelease(
  platform: { os: string; arch: string } = { os: process.platform, arch: process.arch },
): Release {
  const cpu = CPU_RELEASES[platform.os + "-" + platform.arch];
  if (cpu) return cpu;
  requireValue(
    platform.os === "darwin" && (platform.arch === "arm64" || platform.arch === "x64"),
    "unsupported_platform",
    "Managed llama.cpp supports macOS arm64/x64 and CPU x64 on Linux/Windows; compilation is not available.",
  );
  return RELEASES[platform.arch as keyof typeof RELEASES];
}
