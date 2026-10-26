export type BasketAttentionAction = "reindex" | "relink" | "settings" | "review";
export interface BasketAttentionIssue {
  sourceId: string;
  revision: number;
  displayName: string;
  status: "stale" | "missing" | "failed" | "unsupported";
  title: string;
  detail: string;
  action: BasketAttentionAction;
  label: string;
}

export declare function projectBasketAttention(view: unknown): BasketAttentionIssue[];
