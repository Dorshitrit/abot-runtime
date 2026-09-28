/** Private structured OS adapter contract. Never projected as a model tool schema. */
export type ComputerPlatform = "windows" | "macos" | "linux";
export type PhysicalPoint = Readonly<{ x: number; y: number }>;
export type PhysicalRectangle = Readonly<
  PhysicalPoint & { width: number; height: number }
>;
export type ComputerButton = "left" | "middle" | "right";

/** Plugin maps image coordinates to the backend's native desktop coordinate space. */
export type NativeComputerAction =
  | {
      kind: "click";
      point: PhysicalPoint;
      button: ComputerButton;
      count: 1 | 2;
    }
  | { kind: "move"; point: PhysicalPoint }
  | {
      kind: "drag";
      from: PhysicalPoint;
      to: PhysicalPoint;
      button: ComputerButton;
      durationMs: number;
    }
  /** Signed wheel units: 120 is a conventional notch; positive right/down. */
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "type_text"; text: string }
  | { kind: "press_keys"; keys: string[] }
  | { kind: "focus_window"; windowBinding: string };

export type ComputerCapability = Readonly<{
  supported: boolean;
  available: boolean;
  reason?: string;
}>;
export type NativeComputerWindow = Readonly<{
  binding: string;
  title: string;
  application?: string;
  bounds: PhysicalRectangle;
  focused: boolean;
}>;
export type ComputerAccessibilityNode = Readonly<{
  role: string;
  name?: string;
  value?: string;
  bounds?: PhysicalRectangle;
  focused?: boolean;
}>;
export type NativeComputerDesktop = Readonly<{
  platform: ComputerPlatform;
  /** Opaque identity of the session and capture-source topology; changes invalidate observations. */
  binding: string;
  name: string;
  available: boolean;
  reason?: string;
  bounds: PhysicalRectangle;
  coordinateSpace?: "physical_pixels" | "logical_points";
  capabilities: Readonly<{
    capture: ComputerCapability;
    accessibility: ComputerCapability;
    input: ComputerCapability;
    windows: ComputerCapability;
  }>;
  targetingGuarantee: "verified_window" | "observed_surface";
}>;
export type NativeComputerObservation = Readonly<{
  capturedAt: string;
  region: PhysicalRectangle;
  imageWidth: number;
  imageHeight: number;
  accessibility: readonly ComputerAccessibilityNode[];
  accessibilityTruncated: boolean;
}>;
export type NativeComputerDispatch = Readonly<{
  status: "not_dispatched" | "accepted" | "partial" | "unknown";
  requestedInputCount: number;
  acceptedInputCount?: number;
  reason?: string;
}>;
export type NativeComputerResult = Readonly<{
  desktop: NativeComputerDesktop;
  windows: readonly NativeComputerWindow[];
  focusedWindow?: string;
  observation?: NativeComputerObservation;
  image?: Readonly<{ mimeType: "image/png"; bytes: Uint8Array }>;
  dispatch?: NativeComputerDispatch;
  error?: Readonly<{ code: string; message: string }>;
}>;
export type NativeComputerRequest =
  | { operation: "inspect" }
  | { operation: "observe"; region?: undefined }
  | {
      operation: "observe";
      region: PhysicalRectangle;
      desktopBinding: string;
      expectedGeometry: PhysicalRectangle;
    }
  | {
      operation: "act";
      desktopBinding: string;
      expectedWindow?: string;
      expectedGeometry: PhysicalRectangle;
      action: NativeComputerAction;
      deadlineEpochMs: number;
    };
export interface NativeComputerBackend {
  execute(
    request: NativeComputerRequest,
    signal?: AbortSignal,
  ): Promise<NativeComputerResult>;
  close(): Promise<void>;
}
