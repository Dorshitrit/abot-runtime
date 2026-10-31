import type { RuntimeSetupInput } from "../runtime-setup-guide.js";
export declare function runtimeSetupConnectionInput(
  state: Record<string, unknown>, container: Pick<HTMLElement, "querySelector">,
  fieldError: (field: string, message: string) => void,
): RuntimeSetupInput | null;
