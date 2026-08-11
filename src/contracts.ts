/** Shared domain contracts for the incremental TypeScript migration. */

export interface AppManifest {
  name: string;
  short_name: string;
  lang: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: Array<{
    src: string;
    sizes: string;
    type: string;
    purpose: "any maskable";
  }>;
}

export interface AppSession {
  version: number;
  title: string;
  updatedAt: string;
  history: string[];
}

export interface AppSummary {
  id: string;
  title: string;
  version: number;
  versions: number;
  updatedAt: string | null;
  size: number;
  url: string;
}

export interface DeployResult {
  mode: string;
  ok: boolean;
  detail: string;
}

export interface SseEvent {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  [key: string]: unknown;
}

export interface GenerateResult {
  id: string;
  sessionId: string;
  title: string;
  version: number;
  isIteration: boolean;
  feedback: string;
  changes: string;
  url: string;
  files: string[];
  deploy: DeployResult;
}

export type GenerationStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface GenerationJob {
  id: string;
  status: GenerationStatus;
  createdAt: string;
  updatedAt: string;
  events: Array<Record<string, unknown>>;
  result: GenerateResult | null;
  error: string | null;
}
