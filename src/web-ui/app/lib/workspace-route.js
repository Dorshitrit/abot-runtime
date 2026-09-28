import { configurationCategoryForWorkspace, legacyConfigurationWorkspace } from "./configuration-pages.js";

const WORKSPACE_PATHS = Object.freeze({
  home: "/home",
  notifications: "/notifications",
  chat: "/chat",
  schedules: "/schedules",
  learning: "/learning",
  memory: "/memory",
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
  return {
    workspace,
    environment: routeParameter(parameters, "environment"),
    session: routeParameter(parameters, "session"),
    category: configurationCategoryForWorkspace(workspace) || "",
    tab: routeParameter(parameters, "tab"),
    job: routeParameter(parameters, "job"),
  };
}

export function workspaceRouteUrl(route) {
  const workspace = route.workspace === "config" && route.category
    ? legacyConfigurationWorkspace(route.category)
    : route.workspace;
  const path = WORKSPACE_PATHS[workspace] || WORKSPACE_PATHS.home;
  const parameters = new URLSearchParams();
  if (route.environment) parameters.set("environment", route.environment);
  if (workspace === "chat" && route.session)
    parameters.set("session", route.session);
  if (workspace === "config") {
    if (route.tab) parameters.set("tab", route.tab);
  }
  if (workspace === "schedules" && route.job)
    parameters.set("job", route.job);
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

export function configuredRouteEnvironment(environmentId, options) {
  return options.some((option) => option.value === environmentId);
}
