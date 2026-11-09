export type TemplateMode = "all-roles" | "first-system-only";
type TemplateMessage = {
  role: string;
  content: string;
  name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
};

// Reproduce the role selection in the gpt-oss reference template, without inference.
export function renderLlamaCppTemplate(input: unknown, template: TemplateMode = "all-roles"): string {
  if (!Array.isArray(input)) throw new Error("template fixture expected messages");
  const messages = input as TemplateMessage[];
  return messages.flatMap((message, index) => {
    if (template === "first-system-only" && message.role === "system" && index !== 0) return [];
    if (message.tool_calls) {
      return message.tool_calls.map(({ function: call }) =>
        `<|start|>assistant to=functions.${call.name}<|message|>${call.arguments}<|call|>`);
    }
    if (message.role === "tool") {
      return [`<|start|>functions.${message.name} to=assistant<|message|>${message.content}<|end|>`];
    }
    const role = message.role === "system" ? "developer" : message.role;
    return [`<|start|>${role}<|message|>${message.content}<|end|>`];
  }).join("");
}
