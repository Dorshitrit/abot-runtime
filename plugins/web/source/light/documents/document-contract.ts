export type DiscoveryCandidate = Readonly<{
  url: string;
  title: string;
  kind: "page" | "feed" | "sitemap";
  publishedAt?: string;
  updatedAt?: string;
  text?: string;
}>;

export type LightDocument = Readonly<{
  canonicalUrl: string;
  title: string;
  text: string;
  kind: "page" | "feed" | "sitemap";
  links: readonly DiscoveryCandidate[];
  publishedAt?: string;
  updatedAt?: string;
  partial: boolean;
  noIndex?: boolean;
}>;
