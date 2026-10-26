import type { BasketAttentionIssue } from "../../lib/information-basket-attention.js";

export interface DashboardResourceAttention {
  supported?: boolean;
  issues?: readonly BasketAttentionIssue[];
  error?: string;
  mutation?: string;
  mutationError?: string;
  message?: string;
  loading?: boolean;
}
export declare function hasDashboardResourceAttention(snapshot?: DashboardResourceAttention): boolean;
export declare function renderDashboardResources(snapshot?: DashboardResourceAttention): string;
export declare function dashboardResourcesSummary(snapshot?: DashboardResourceAttention): {
  count: number;
  title: string;
  detail: string;
  status: string;
  tone: string;
  preview?: {
    kind: "rows";
    badge: { value: number; label: string; tone: string };
    items: Array<{ title: string; detail: string; indicator: { icon: string; label: string; tone: string } }>;
  };
};
