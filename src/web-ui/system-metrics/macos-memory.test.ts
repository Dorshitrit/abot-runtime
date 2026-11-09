import { expect, test, vi } from "vitest";
import { parseMacosMemory, readMacosMemory } from "./macos-memory.js";
import { createSystemObservationReader } from "./observation.js";

function statistics(pageSize = 16384) {
  return `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free: 1638323.
Pages active: 1728874.
Pages inactive: 4628090.
Pages speculative: 6547.
Pages wired down: 271446.
Pages purgeable: 43731.
File-backed pages: 4973168.
Anonymous pages: 1390343.
Pages stored in compressor: 169412.
Pages occupied by compressor: 63487.`;
}

test.each([4096, 16384])("macOS RAM excludes file cache and counts compressed physical pages at page size %s", pageSize => {
  const memory = parseMacosMemory(statistics(pageSize), 128 * 1024 ** 3)!;
  // Includes resident app pages + wired + compressor, minus purgeable pages.
  expect(memory.usedBytes).toBe(1_681_545 * pageSize);
  expect(memory.basis).toBe("vm_stat"); expect(memory.percent).toBeLessThan(21);
  const moreCache = statistics(pageSize).replace("4973168.", "6000000.").replace("4628090.", "5654922.");
  expect(parseMacosMemory(moreCache, memory.totalBytes!)).toEqual(memory);
});

test.each([
  "", statistics().replace("16384 bytes", "0 bytes"), statistics().replace("Pages purgeable: 43731.\n", ""),
  statistics().replace("1390343.", "-1."), statistics().replace("43731.", "9000000."),
  statistics().replace("1390343.", "9007199254740992."),
])("malformed or incomplete macOS counters cannot fabricate zero/negative memory usage", output => {
  expect(parseMacosMemory(output, 128 * 1024 ** 3)).toBeNull();
});

test("a failed OS read returns null for an explicitly labelled free-memory fallback", async () => {
  expect(await readMacosMemory(1000, async () => { throw new Error("unavailable"); })).toBeNull();
  const vmStat = vi.fn(async () => "");
  const observe = createSystemObservationReader({ platform: "darwin", vmStat, cpus: () => [],
    totalmem: () => 1000, freemem: () => 300 });
  expect((await observe()).memory).toEqual({ usedBytes: 700, totalBytes: 1000, percent: 70, basis: "free" });
  expect(vmStat).toHaveBeenCalledOnce();
});

test("the macOS observation uses native counters while Windows does not spawn vm_stat", async () => {
  const vmStat = vi.fn(async () => statistics());
  const options = { vmStat, cpus: () => [], totalmem: () => 128 * 1024 ** 3, freemem: () => 0 };
  expect((await createSystemObservationReader({ ...options, platform: "darwin" })()).memory.basis).toBe("vm_stat");
  expect((await createSystemObservationReader({ ...options, platform: "win32" })()).memory.basis).toBe("free");
  expect(vmStat).toHaveBeenCalledOnce();
});
