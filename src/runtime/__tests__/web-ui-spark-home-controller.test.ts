import { expect, test, vi } from "vitest";
// @ts-expect-error Browser controller.
import { createSparkHomeController } from "../../web-ui/app/controllers/spark-home-controller.js";

function fixture() {
  let environment = "dev";
  const screen = { revision: 1, updatedAt: "first" };
  const client = {
    getSparkHome: vi.fn(async () => ({ screen })),
    getSparkHomeSettings: vi.fn(async () => ({ settings: { revision: 7, available: true, reason: null } })),
    getSparkHomePreferences: vi.fn(async () => ({ preferences: { revision: 3, mode: "spark_home" } })),
    configureSparkHomePreferences: vi.fn(async (input: any, _environment: string) => ({ preferences: { revision: 4, mode: input.mode } })),
  };
  const render = vi.fn(); const requestScreen = vi.fn(async () => true); const confirmRequest = vi.fn(async () => true);
  const controller = createSparkHomeController({ client, getEnvironmentId: () => environment, isAvailable: () => true,
    render, requestScreen, confirmRequest, onModeChange: vi.fn() });
  return { client, render, requestScreen, confirmRequest, controller,
    environment: (value: string) => { environment = value; return controller.environmentChanged(); } };
}

test("restores HOME preference from its owner and saves Dashboard with the acknowledged revision", async () => {
  const h = fixture(); await h.controller.setActive(true);
  expect(h.controller.state()).toMatchObject({ mode: "spark", configured: true, settingsRevision: 7 });
  await h.controller.selectMode("dashboard");
  expect(h.client.configureSparkHomePreferences).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 3, mode: "dashboard" }, "dev");
  expect(h.requestScreen).not.toHaveBeenCalled();
});

test("explicit confirmation sends only the saved settings revision, and decline sends nothing", async () => {
  const h = fixture(); await h.controller.setActive(true);
  h.confirmRequest.mockResolvedValueOnce(false);
  expect(await h.controller.requestNewScreen()).toBe(false);
  expect(h.requestScreen).not.toHaveBeenCalled();
  expect(await h.controller.requestNewScreen()).toBe(true);
  expect(h.requestScreen).toHaveBeenCalledExactlyOnceWith(7);
});

test("a committed update is adopted while unchanged revisions preserve the existing screen object", async () => {
  const h = fixture(); await h.controller.setActive(true); const original = h.controller.state().screen;
  h.client.getSparkHome.mockResolvedValue({ screen: { revision: 1, updatedAt: "first" } });
  await h.controller.refresh(); expect(h.controller.state().screen).toBe(original);
  h.client.getSparkHome.mockResolvedValue({ screen: { revision: 2, updatedAt: "new" } });
  await h.controller.refresh(); expect(h.controller.state().screen).toMatchObject({ revision: 2 });
});

test("missing HOME eligibility blocks generation while preserving setup and screen reading", async () => {
  const h = fixture();
  h.client.getSparkHomeSettings.mockResolvedValue({ settings: { revision: 7, available: false, reason: "spark_home_model_required" as any } });
  await h.controller.setActive(true);
  expect(h.controller.state()).toMatchObject({ available: false, configured: false, reason: "spark_home_model_required" });
  expect(await h.controller.requestNewScreen()).toBe(false);
  expect(h.confirmRequest).not.toHaveBeenCalled();
});

test("a confirmation from a previous environment cannot create a new-environment screen", async () => {
  const h = fixture(); await h.controller.setActive(true);
  let finish!: (value: boolean) => void;
  h.confirmRequest.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = h.controller.requestNewScreen();
  await h.environment("prod"); finish(true);
  expect(await pending).toBe(false); expect(h.requestScreen).not.toHaveBeenCalled();
});

test.each([true, false])("widget minimum rejection stops generation and preserves the current screen (existing=%s)", async existing => {
  const h = fixture();
  if (!existing) h.client.getSparkHome.mockResolvedValueOnce({ screen: null as any });
  await h.controller.setActive(true);
  const original = h.controller.state().screen;
  h.controller.setRun({ run: { status: "running" }, connected: true, error: "" });
  expect(h.controller.state().generationPhase).toBe("working");
  h.controller.setRun({ run: { status: "failed", errorCode: "spark_home_dashboard_widgets_required" }, connected: true, error: "" });
  expect(h.controller.state().generationPhase).toBe("");
  expect(h.controller.state().generationNotice).toContain("fewer than three Dashboard widgets");
  expect(h.controller.state().generationNotice).toContain("not saved");
  expect(h.controller.state().screen).toBe(original);
  expect(h.requestScreen).not.toHaveBeenCalled();
  expect(h.client.getSparkHome).toHaveBeenCalledTimes(1);
  h.controller.setRun({ run: { status: "failed", errorCode: "spark_home_html_invalid" }, connected: true, error: "" });
  expect(h.controller.state().generationNotice).toBe("HOME did not finish creating a screen. Open SPARK for details.");
});
