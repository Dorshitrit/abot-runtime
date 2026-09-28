export interface WorkspaceRoute {
  workspace: string;
  environment: string;
  session: string;
  category: string;
  tab: string;
  job: string;
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
