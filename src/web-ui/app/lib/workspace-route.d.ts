export interface WorkspaceRoute {
  workspace: string;
  environment: string;
  session: string;
  automationRun: string;
  category: string;
  tab: string;
  job: string;
  automation: string;
  run: string;
}

export function readWorkspaceRoute(
  location: Pick<Location, "pathname" | "search">,
): WorkspaceRoute;

export function workspaceRouteUrl(
  route: Partial<WorkspaceRoute> & Record<string, unknown>,
): string;

export function configuredRouteEnvironment(
  environmentId: string,
  options: Array<{ value: string }>,
): boolean;
