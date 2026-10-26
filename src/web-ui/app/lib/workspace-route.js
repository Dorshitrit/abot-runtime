import { configurationCategoryForWorkspace, legacyConfigurationWorkspace } from "./configuration-pages.js";

const WORKSPACE_PATHS = Object.freeze({
  home: "/home",
  notifications: "/notifications",
  chat: "/chat",
  schedules: "/schedules",
  automations: "/automations",
  learning: "/learning",
  memory: "/memory",
  skills: "/skills",
  resources: "/resources",
  models: "/models",
  plugins: "/plugins",
  config: "/system",
});

function routeParameter(parameters, name) {
  const value = parameters.get(name) || "";
  return value.length <= 512 ? value : "";
}

export function readWorkspaceRoute(location) {
  const path = location.pathname.replace(/\/$/, "") || "/";
  const requestedWorkspace = Object.keys(WORKSPACE_PATHS).find(
    (name) => WORKSPACE_PATHS[name] === path,
  );
  const parameters = new URLSearchParams(location.search);
  const requestedCategory = routeParameter(parameters, "category");
  const workspace = path === "/config"
    ? legacyConfigurationWorkspace(requestedCategory)
    : requestedWorkspace || "home";
  const automationRun = workspace === "chat" ? routeParameter(parameters, "automationRun") : "";
  return {
    workspace,
    environment: routeParameter(parameters, "environment"),
    session: automationRun ? "" : routeParameter(parameters, "session"),
    automationRun,
    category: configurationCategoryForWorkspace(workspace) || "",
    tab: routeParameter(parameters, "tab"),
    job: routeParameter(parameters, "job"),
    automation: routeParameter(parameters, "automation"),
    run: routeParameter(parameters, "run"),
    ...(workspace === "plugins" && parameters.has("pluginSource") ? { pluginSource: routeParameter(parameters, "pluginSource"), pluginRef: routeParameter(parameters, "pluginRef"), pluginPath: routeParameter(parameters, "pluginPath") } : {}),
  };
}

export function workspaceRouteUrl(route) {
  const workspace = route.workspace === "config" && route.category
    ? legacyConfigurationWorkspace(route.category)
    : route.workspace;
  const path = WORKSPACE_PATHS[workspace] || WORKSPACE_PATHS.home;
  const parameters = new URLSearchParams();
  if (route.environment) parameters.set("environment", route.environment);
  if (workspace === "chat" && route.automationRun)
    parameters.set("automationRun", route.automationRun);
  else if (workspace === "chat" && route.session)
    parameters.set("session", route.session);
  if (workspace === "plugins") {
    if (route.tab === "discover") parameters.set("tab", "discover");
  }
  if (workspace === "config") {
    if (route.tab) parameters.set("tab", route.tab);
  }
  if (workspace === "schedules" && route.job)
    parameters.set("job", route.job);
  if (workspace === "automations" && route.automation)
    parameters.set("automation", route.automation);
  if (workspace === "automations" && route.run)
    parameters.set("run", route.run);
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

export function configuredRouteEnvironment(environmentId, options) {
  return options.some((option) => option.value === environmentId);
}
