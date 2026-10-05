import { expect, test } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationLiveView } from "../../web-ui/app/components/automations/live-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

test("loading and replacing a step result preserves the scrolling workspace outside the rendered region", () => {
  const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
  const workspace = Object.assign(new FakeElement("main", document), { scrollLeft: 0 });
  const root = new FakeElement("section", document);
  workspace.append(root);
  Object.defineProperty(root, "firstChild", { get: () => root.children[0] });
  const html = Object.getOwnPropertyDescriptor(FakeElement.prototype, "innerHTML")!;
  Object.defineProperty(root, "innerHTML", {
    get: () => html.get!.call(root),
    set(value: string) {
      // Browser layout clamps the outer scroll when innerHTML removes the old content.
      workspace.scrollTop = 0;
      workspace.scrollLeft = 0;
      html.set!.call(root, value);
    },
  });
  const live = createAutomationLiveView(root);
  live.update("automation/run", "<p>First saved result</p>");
  workspace.scrollTop = 620;
  workspace.scrollLeft = 12;
  live.update("automation/run", "<p>Loading the selected result</p>");
  expect(workspace.scrollTop).toBe(620);
  expect(workspace.scrollLeft).toBe(12);
  live.update("automation/run", "<article>New saved result</article>");
  expect(workspace.scrollTop).toBe(620);
  live.update("another-automation/run", "<p>Another run</p>");
  expect(workspace.scrollTop).toBe(0);
});
