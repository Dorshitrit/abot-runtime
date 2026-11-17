import type { ModelGenerationConfig } from "../../model-gateway/types.js";
import { mergeModelGenerationConfig } from "../../model-gateway/policy/model-generation-merge.js";
import { buildModelGenerationConfig } from "./model-generation-config.js";
import { isRecord } from "./utils.js";

export type NormalizedModelProfileSource = Record<string, unknown> & {
  generation?: ModelGenerationConfig;
  calibration?: Record<string, NormalizedModelProfileSource>;
};

function mergeRawCalibration(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, NormalizedModelProfileSource> {
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(base), ...Object.keys(override)])).map(
      (slotId) => {
        const baseSlot = base[slotId];
        const overrideSlot = override[slotId];
        return [
          slotId,
          mergeModelProfileSources(
            isRecord(baseSlot) ? baseSlot : {},
            isRecord(overrideSlot) ? overrideSlot : {},
          ),
        ];
      },
    ),
  );
}

export function mergeModelProfileSources(
  referenced: Record<string, unknown>,
  inline: Record<string, unknown>,
): NormalizedModelProfileSource {
  const mergedFields = { ...referenced, ...inline };
  delete mergedFields.generation;
  delete mergedFields.calibration;
  return {
    ...mergedFields,
    ...(isRecord(referenced.options) || isRecord(inline.options)
      ? {
          options: {
            ...(isRecord(referenced.options) ? referenced.options : {}),
            ...(isRecord(inline.options) ? inline.options : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.generation) || isRecord(inline.generation)
      ? {
          generation: mergeModelGenerationConfig(
            buildModelGenerationConfig(referenced.generation),
            buildModelGenerationConfig(inline.generation),
          ),
        }
      : {}),
    ...(isRecord(referenced.context) || isRecord(inline.context)
      ? {
          context: {
            ...(isRecord(referenced.context) ? referenced.context : {}),
            ...(isRecord(inline.context) ? inline.context : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.capabilities) || isRecord(inline.capabilities)
      ? {
          capabilities: {
            ...(isRecord(referenced.capabilities)
              ? referenced.capabilities
              : {}),
            ...(isRecord(inline.capabilities) ? inline.capabilities : {}),
          },
        }
      : {}),
    ...(isRecord(referenced.calibration) || isRecord(inline.calibration)
      ? {
          calibration: mergeRawCalibration(
            isRecord(referenced.calibration) ? referenced.calibration : {},
            isRecord(inline.calibration) ? inline.calibration : {},
          ),
        }
      : {}),
  };
}
