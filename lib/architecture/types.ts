export type BlueprintKind = "docker" | "compose" | "terraform" | "cloudformation" | "kubernetes" | "dependencies" | "documentation" | "yaml";
export type Evidence = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  kind: BlueprintKind;
  text: string;
  origin?: "attachment";
};
export type RepositoryIndex = {
  version: 1;
  id: string;
  ownerKey: string;
  repository: { owner: string; name: string; url: string; commit: string };
  createdAt: string;
  discoveredFiles: number;
  files: Array<{ path: string; kind: BlueprintKind; bytes: number }>;
  evidence: Evidence[];
  warnings: string[];
  instructions?: string;
};
export class RepositoryError extends Error {
  constructor(message: string, public code = "REPOSITORY_ERROR", public retryable = false, public nextRetryAt?: number) { super(message); }
}
