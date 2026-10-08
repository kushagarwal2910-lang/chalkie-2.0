export type BlueprintKind = "docker" | "compose" | "terraform" | "cloudformation" | "kubernetes" | "dependencies" | "documentation" | "yaml" | "source";
export type RepositoryTreeEntry = { path: string; bytes: number; kind: "source" | "blueprint" | "other"; language?: string };
export type SourceParser = "typescript-ast" | "python-cst" | "cpp-cst" | "java-cst" | "go-cst" | "rust-cst" | "text";
export type SourceDefinition = { name: string; kind: "function" | "method" | "class" | "interface" | "type" | "variable"; startLine: number; endLine: number };
export type SourceFileIndex = { path: string; language: string; parser: SourceParser; imports: string[]; symbols: string[]; definitions?: SourceDefinition[]; analysisComplete?: boolean };
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
  analysisVersion?: number;
  research?: { searchedFiles: number; fetchedFiles: number; paths: string[]; notes: string[] };
};
export class RepositoryError extends Error {
  constructor(message: string, public code = "REPOSITORY_ERROR", public retryable = false, public nextRetryAt?: number) { super(message); }
}
