// Verified 2026-09-18 against https://nodejs.org/dist/index.json and
// https://nodejs.org/dist/v24.21.0/SHASUMS256.txt. Keep updates explicit.
export const COMPANION_NODE_VERSION = "v24.21.0";
export const COMPANION_NODE_DISTRIBUTIONS = {
  "win-x64": { archive: "node-v24.21.0-win-x64.zip", sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
  "win-arm64": { archive: "node-v24.21.0-win-arm64.zip", sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921" },
  "darwin-x64": { archive: "node-v24.21.0-darwin-x64.tar.gz", sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" },
  "darwin-arm64": { archive: "node-v24.21.0-darwin-arm64.tar.gz", sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" },
} as const;
