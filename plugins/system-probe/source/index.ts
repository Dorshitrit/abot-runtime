import { statfs } from "node:fs/promises";

import {
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  readOptionalString,
  resolvePluginPath,
  successResult,
} from "../../../src/plugin-sdk/index.js";

import { bytesToGiB, formatDuration, readMachineMetrics } from "./metrics.js";

const ALLOWED_PATH_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace",
  "host_system",
] as const);

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export default defineRuntimePlugin((context) => ({
  handlers: {
    async system_probe(params) {
      const explicitPath = readOptionalString(params.path);
      try {
        const target = resolvePluginPath(context, explicitPath ?? "/", {
          requirePath: true,
          allowedLocations: ALLOWED_PATH_LOCATIONS,
        });
        let disk:
          | Readonly<{
              totalBytes: number;
              freeBytes: number;
              usedBytes: number;
            }>
          | undefined;
        let diskStatus: "available" | "unavailable" = "available";
        try {
          const info = await statfs(target.absolutePath);
          const blockSize = Number(info.bsize);
          const totalBytes = blockSize * Number(info.blocks);
          const freeBytes = blockSize * Number(info.bavail);
          disk = Object.freeze({
            totalBytes,
            freeBytes,
            usedBytes: Math.max(0, totalBytes - freeBytes),
          });
        } catch (error) {
          if (explicitPath) {
            const code = filesystemErrorCode(error);
            if (code === "ENOENT" || code === "ENOTDIR") {
              return failureResult({
                errorCode: "system_probe_path_not_found",
                message: "The requested disk-probe path does not exist.",
              });
            }
            if (code === "EACCES" || code === "EPERM") {
              return failureResult({
                errorCode: "system_probe_path_inaccessible",
                message: "The requested disk-probe path is not accessible.",
              });
            }
            return failureResult({
              errorCode: "system_probe_disk_unavailable",
              message:
                "Disk statistics are unavailable for the requested path.",
            });
          }
          diskStatus = "unavailable";
        }

        const machine = readMachineMetrics();
        const output = [
          "System probe summary:",
          "system_status: responsive",
          `platform: ${machine.platform}`,
          `arch: ${machine.architecture}`,
          `uptime: ${formatDuration(machine.uptimeSeconds)}`,
          `cpu_count: ${machine.cpuCount}`,
          `load_level: ${machine.loadLevel}`,
          `load_average: ${machine.loadAverage.map((value) => value.toFixed(2)).join(" ")}`,
          `memory_used: ${bytesToGiB(machine.memoryUsedBytes)} / ${bytesToGiB(machine.memoryTotalBytes)}`,
          `memory_free: ${bytesToGiB(machine.memoryFreeBytes)}`,
          `disk_path: ${target.logicalPath}`,
          `disk_status: ${diskStatus}`,
          ...(disk
            ? [
                `disk_used: ${bytesToGiB(disk.usedBytes)} / ${bytesToGiB(disk.totalBytes)}`,
                `disk_free: ${bytesToGiB(disk.freeBytes)}`,
              ]
            : []),
        ].join("\n");
        return successResult({
          output,
          producedNewInformation: true,
          data: {
            hasData: true,
            itemCount: 1,
            diskPath: target.logicalPath,
            diskStatus,
            machine,
            ...(disk ? { disk } : {}),
            observationMeta: {
              kind: "volatile_external",
              carryPolicy: "never",
            },
          },
        });
      } catch (error) {
        return failureFromError(error, {
          fallbackCode: "system_probe_failed",
          fallbackMessage: "System probe failed.",
          operation: "system_probe",
        });
      }
    },
  },
}));
