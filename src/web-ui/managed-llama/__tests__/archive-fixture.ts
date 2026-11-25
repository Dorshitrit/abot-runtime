import JSZip from "jszip";
import { gzipSync } from "node:zlib";
export async function zipFixture(files: Record<string, string> = { "llama-server.exe": "synthetic engine", "engine.dll": "synthetic library" }) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
export function tarFixture(gnu = true) {
  const header = Buffer.alloc(512), data = Buffer.from("synthetic engine");
  header.write("bin/llama-server"); header.write("0000700\0", 100);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156); header.write("0", 156);
  header.write(gnu ? "ustar  \0" : "ustar\0" + "00", 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(512 - data.length), Buffer.alloc(1024)]));
}
