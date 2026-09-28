export function createStartupScreen({
  documentRoot = document,
  reload = () => window.location.reload(),
} = {}) {
  const app = documentRoot.getElementById("app");
  const startup = documentRoot.getElementById("appStartup");
  const status = documentRoot.getElementById("startupStatus");
  const retry = documentRoot.getElementById("startupRetry");
  retry.addEventListener("click", reload);

  function ready() {
    app.removeAttribute("data-startup-pending");
    app.removeAttribute("aria-busy");
    app.inert = false;
    startup.hidden = true;
  }

  function fail(error) {
    app.setAttribute("data-startup-pending", "");
    app.setAttribute("aria-busy", "true");
    app.inert = true;
    startup.hidden = false;
    status.setAttribute("role", "alert");
    const detail = error instanceof Error ? error.message : String(error);
    status.textContent = `ABot could not open. ${detail}`;
    retry.hidden = false;
  }

  return { ready, fail };
}
