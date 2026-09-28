import {
  failureResult,
  successResult,
  type ToolExecutionContext,
} from "../../../../src/plugin-sdk/index.js";
import { SystemOperationError } from "../../../../src/plugin-sdk/computer-access.js";
import type { NativeComputerResult } from "../../../../src/plugin-sdk/computer-access.js";
import {
  computerRouteLabel,
  type RequestComputer,
} from "./request-computers.js";
import { serializeComputerObservation } from "./observation-output.js";

export function describeDesktop(
  entry: RequestComputer,
  result: NativeComputerResult,
) {
  const {
    binding: _binding,
    bounds: _bounds,
    coordinateSpace: _coordinateSpace,
    ...desktop
  } = result.desktop;
  return {
    ...computerRouteLabel(entry),
    ...desktop,
    ...entry.bindings.observe(result),
  };
}

export async function projectComputerResult(
  entry: RequestComputer,
  result: NativeComputerResult,
  context: ToolExecutionContext,
) {
  const media = [];
  let imageFailure: string | undefined;
  if (result.image) {
    try {
      const image = await context.media!.writeImage(result.image);
      if (!hasMatchingImageGeometry(image, result))
        throw new SystemOperationError(
          "computer_image_geometry_mismatch",
          "Native observation dimensions do not match the captured image. Observe again before input.",
        );
      media.push(image);
    } catch (error) {
      imageFailure =
        error instanceof Error ? error.message : "Image admission failed.";
    } finally {
      result.image.bytes.fill(0);
    }
  }
  const description = describeDesktop(entry, result);
  if (media.length === 0) {
    entry.bindings.clear();
    description.observation_ref = undefined;
  }
  const hasPartialInputDispatch = result.dispatch?.status === "partial";
  const operationError = result.error ?? (hasPartialInputDispatch
    ? { code: "computer_input_partial", message: "Only part of the input was accepted." }
    : undefined);
  const data = {
    desktop_ref: entry.ref,
    ...(description.observation_ref
      ? { observation_ref: description.observation_ref }
      : {}),
    ...(result.dispatch ? { dispatch: result.dispatch } : {}),
    ...inputDispatchEvidence(entry.ref, result.dispatch),
    currentStateEvidence: Boolean(result.observation),
    ...(operationError ? { error: operationError } : {}),
    ...(imageFailure ? { imageError: imageFailure } : {}),
    imageAvailable: media.length > 0,
    evidenceScope: "observed_desktop_and_input_receipt",
    requestedEffectVerified: false,
    observationMeta: {
      kind: "volatile_external",
      carryPolicy: "never",
    } as const,
  };
  const output = serializeComputerObservation(description, data);
  if (imageFailure || operationError)
    return failureResult({
      errorCode: operationError?.code ?? "computer_image_unavailable",
      message: operationError?.message ?? imageFailure!,
      output,
      data,
      media,
    });
  return successResult({ output, data, media });
}

function inputDispatchEvidence(
  desktopRef: string,
  dispatch: NativeComputerResult["dispatch"],
) {
  if (!dispatch || !["accepted", "partial"].includes(dispatch.status))
    return {};
  const accepted = dispatch.acceptedInputCount;
  if (!Number.isSafeInteger(accepted) || !accepted || accepted < 0) return {};
  if (!Number.isSafeInteger(dispatch.requestedInputCount)) return {};
  if (accepted > dispatch.requestedInputCount) return {};
  return {
    mutationEvidence: true,
    mutationGrounding: JSON.stringify({
      kind: "computer_input_receipt_v1",
      desktop_ref: desktopRef,
      dispatch,
      evidenceScope: "native_input_dispatch_only",
      requestedEffectVerified: false,
    }),
  };
}

function hasMatchingImageGeometry(
  image: { width: number; height: number },
  result: NativeComputerResult,
): boolean {
  if (!result.observation) return false;
  if (image.width !== result.observation.imageWidth) return false;
  return image.height === result.observation.imageHeight;
}
