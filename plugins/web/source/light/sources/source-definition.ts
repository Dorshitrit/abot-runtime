export type LightSource = Readonly<{
  id: string;
  title: string;
  description: string;
  keywords: readonly string[];
  languages: readonly string[];
  entryUrls: readonly string[];
  allowedOrigins: readonly string[];
}>;
