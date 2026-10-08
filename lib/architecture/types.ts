export type BlueprintKind = "docker" | "compose" | "terraform" | "cloudformation" | "kubernetes" | "dependencies" | "documentation" | "yaml" | "source";
export type RepositoryTreeEntry = { path: string; bytes: number; kind: "source" | "blueprint" | "other"; language?: string };
export type SourceFileIndex = { path: string; language: string; parser: "typescript-ast" | "python-cst" | "text"; imports: string[]; symbols: string[] };
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
  tree?: RepositoryTreeEntry[];
  sourceFiles?: SourceFileIndex[];
  research?: { searchedFiles: number; fetchedFiles: number; paths: string[]; notes: string[] };
};
export class RepositoryError extends Error {
  constructor(message: string, public code = "REPOSITORY_ERROR", public retryable = false, public nextRetryAt?: number) { super(message); }
}
