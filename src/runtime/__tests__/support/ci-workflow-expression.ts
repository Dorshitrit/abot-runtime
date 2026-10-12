import { data, Evaluator, Lexer, Parser } from "@actions/expressions";

export type CiScenario = Readonly<{
  eventName?: string;
  action?: string;
  privateRepository?: boolean;
  manual?: string;
  label?: string;
  labels?: readonly string[];
  pullRequest?: number;
  runId?: number;
  sha?: string;
  headSha?: string;
  ref?: string;
}>;

export function evaluateCiExpression(
  expression: string,
  overrides: CiScenario = {},
  environment: Readonly<Record<string, string>> = {},
): Readonly<{ value: data.ExpressionData; alwaysCalls: number }> {
  const scenario = {
    eventName: "pull_request",
    action: "synchronize",
    privateRepository: true,
    manual: "true",
    labels: [],
    pullRequest: 17,
    runId: 100,
    sha: "current-merge-commit",
    headSha: "pull-request-head-commit",
    ref: "refs/pull/17/merge",
    ...overrides,
  };
  const context = JSON.parse(
    JSON.stringify({
      github: {
        workflow: "CI",
        event_name: scenario.eventName,
        run_id: scenario.runId,
        sha: scenario.sha,
        ref: scenario.ref,
        event: {
          action: scenario.action,
          number: scenario.pullRequest,
          repository: { private: scenario.privateRepository },
          label: scenario.label === undefined ? undefined : { name: scenario.label },
          pull_request: {
            number: scenario.pullRequest,
            head: { sha: scenario.headSha },
            labels: scenario.labels.map((name) => ({ name })),
          },
        },
      },
      vars: { CI_MANUAL_PR: scenario.manual },
      env: environment,
    }),
    data.reviver,
  ) as data.Dictionary;
  let alwaysCalls = 0;
  const always = {
    name: "always",
    minArgs: 0,
    maxArgs: 0,
    call: () => {
      alwaysCalls++;
      return new data.BooleanData(true);
    },
  };
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1");
  const tokens = new Lexer(source).lex().tokens;
  const parsed = new Parser(tokens, ["github", "vars", "env"], [always]).parse();
  return {
    value: new Evaluator(parsed, context, new Map([["always", always]])).evaluate(),
    alwaysCalls,
  };
}
