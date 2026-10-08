# Chalkie

Chalkie connects a public GitHub repository's code, documentation and architectural blueprints into a narrated, interactive diagram. It helps developers onboard, engineering teams understand system behavior, and product or leadership audiences follow the architecture in plain language.

## Run locally

Requires Node.js 22.13+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open the local URL printed by the server. Add a Groq key through **Provider keys**, or set `GROQ_API_KEY` in `.env.local`. Paste a **public** GitHub repository URL and choose an audience. No GitHub account connection or token is required. Private repositories are not supported; unavailable repositories show a public-access explanation instead of a token form.

The app generates an initial walkthrough automatically. Each notebook has its own URL identity; switching, refreshing and importing cannot silently restore a different notebook. The server checks notebook repository, commit and citation identity before follow-up research. Follow-up questions retrieve evidence from the same indexed commit, then either focus existing components or append new components and narration. Voice input uses Groq transcription; narration uses device speech by default, with optional Groq audio.

Narration is prompted as a connected explanation of purpose, inputs, component behavior and outputs, rather than a reading of node captions. It traces supported connections, keeps captions short, and collects important evidence limits into one brief note. General technology explanations are distinguished from repository-specific facts. Saved lessons retain their original script; generate a fresh walkthrough to use an updated narration style.

Device narration expands common engineering names and acronyms locally, preserves normal words, and speaks short sentences with brief pauses while keeping diagram highlights synchronized. Voice settings preview the same readings and pacing without Groq calls; voice quality depends on the voices available in the browser. The compact studio question bar keeps audience, question mode, repository access, and supporting documentation under its settings button.

Open **Add instructions & documentation** on the home page or in the studio's new-repository composer to supply a specific explanation prompt, pasted supporting notes, and Markdown/text documents. For example: “Explain the API and database to a new frontend engineer.” GitHub remains the repository source; these documents add business context, team conventions and architecture details. Attachments are explicitly labeled as supporting evidence, with expandable excerpts instead of fabricated GitHub links. They remain in the owner-scoped index for follow-up questions and their cited excerpts survive JSON export/import. If the repository has no readable source or architecture documents, supplied documentation can support the walkthrough with an explicit coverage warning.

Uploads support UTF-8 `.md`, `.markdown` and `.txt`, at most five files, 100 KB and 20,000 characters per file. Pasted notes allow 20,000 characters; combined documentation is limited to 80,000 characters. Paste text from PDF or Word documents into Supporting notes; binary document parsing and OCR are not included. The home-to-studio handoff uses temporary tab storage, keeping document text and instructions out of URLs. Failed requests retain their original submitted context in memory for retry.

Public imports download a GitHub ZIP snapshot directly from `codeload.github.com`; they make **zero GitHub REST API calls** and no model calls. The importer does not accept or forward GitHub tokens, cookies, or other user credentials. This avoids the 60-request anonymous REST allowance. GitHub can still temporarily throttle archive downloads; the app honors its retry headers without suggesting extra keys. A 404 cannot reveal whether a repository is private, missing, or the branch name is wrong, so the error explains all of those possibilities.

A bounded, 15-minute cache keeps redacted public evidence, the filtered repository file tree and its archive ETag. Every new import revalidates public access; unchanged archives avoid parsing again. User instructions and attachments never enter this shared cache. Follow-ups search the browser-owned index and can read up to twelve relevant files from `raw.githubusercontent.com` at the same commit, following imports and importers for up to two hops. Older indexes without the current symbol map upgrade automatically from that commit. These operations use no GitHub credentials or LLM calls; normal Groq generation limits, GitHub download throttling and hosting resource costs still apply.

The Sources panel includes a searchable, paginated file-and-symbol browser with commit-pinned definition links. The model receives a compact navigation map plus question-specific source passages; the entire repository is not inserted into one prompt. Fresh answer evidence is protected from old-diagram context trimming.

Model requests select bounded excerpts rather than resending entire documents. The serialized explanation request is capped at 14 KB, including schema/history/repair instructions, with a 4,000-token completion allowance. This is a size guard, not exact token accounting or a guarantee against provider limits. [Groq limits](https://console.groq.com/docs/rate-limits) apply at organization level, so multiple keys in one organization share quota.

Groq can reject a generated diagram with `json_validate_failed` even when keys are usable. Chalkie derives append/existing coverage from the payload and maps unsupported node categories to a generic unknown category, without changing labels, claims or citations. It validates any complete draft returned with that error locally and reuses it when valid. Otherwise, it uses its one existing recovery attempt to request a compact JSON object, then applies the same schema, source-reference and graph checks. If both responses are unusable, it generates a clearly labeled basic source overview directly from indexed declarations and excerpts, without another model call. That overview can show Compose services and explicit startup dependencies; it does not invent request flows. A basic follow-up preserves the graph and shows related excerpts with an explicit limitation that they may not answer the question. Recovery uses the same request-size and completion budgets, reducing graph complexity while preserving teaching depth. Quota, access, cancellation, explicit refusals and unrelated request failures remain errors; safe diagnostics record recognized categories and schema-field paths without raw responses or document text.

## What is indexed

The ingestion engine reads the snapshot's embedded commit SHA for immutable citations, maps safe regular files from its ZIP directory and inspects bounded blueprint and application-source files in memory. JavaScript/TypeScript/JSX/TSX use the TypeScript AST; Python, C/C++, Java, Go and Rust use Lezer concrete syntax trees. These parsers record named definitions with exact line ranges, imports, call identifiers and useful implementation excerpts. Definition maps are independent of the initial excerpt set. Syntax errors or parser limits mark coverage as partial; static imports are not resolved runtime calls. Other supported code languages use exact text excerpts, without claiming AST support. No imported code is executed, archive files are extracted to disk, or repository dependencies are installed. This is a snapshot file map, not a clone of Git history; submodules and Git archive exclusions are outside coverage.

- Dockerfiles and Compose: images, services, exposed ports, declared networks, volumes and startup dependencies.
- Terraform HCL/JSON: resources, modules, providers and unresolved references.
- Kubernetes and CloudFormation YAML/JSON: resource declarations and intrinsic references. Other YAML and safe text configurations can be read for a targeted question as documentation, without inventing infrastructure declarations.
- Dependency manifests: `package.json`, requirements files, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, and `Gemfile`.
- High-level documents: README, ARCHITECTURE, AGENTS, onboarding, deployment, runbooks, and architecture decision records, including nested directories.
- Application source: entrypoints, routes/controllers and library code, with bounded exact excerpts and original line citations. Follow-up retrieval can prioritize a named function beyond the overview's excerpts.

Lockfiles, vendored/build directories, environment/credential files, state files, generated paths and symlinks are excluded from content indexing. Obvious credentials are masked before source excerpts or metadata are stored. Redaction is best effort. Repository text, including AGENTS instructions, is untrusted evidence for the explanation model.

Blueprints and static code do not verify production state. An import is not proof a function ran, a package dependency does not prove a deployed service, and Compose `depends_on` describes startup order. Generated components and relationships require exact supporting passages and identity checks; prose interpretations still require judgment. The teaching prompt synthesizes inputs, transformations, handoffs, decisions and outputs. Narration keeps full paths in citations, uses short basenames only when useful and locally removes long file references without extra voice calls.

## Canvas and LLM responsibilities

The canvas uses React Flow with Chalkie's component cards, technology visuals, source inspector and narration controls. ELK calculates node positions; deterministic routing places orthogonal connections and labels. The model supplies semantic JSON: nodes, relationships, evidence IDs, registered asset IDs and explanation steps. It does not supply coordinates, executable graphics or arbitrary image URLs.

You can pan and zoom, drag components with collision correction, connect handles, edit labels, select another visual, filter by subsystem, auto-arrange, and undo or redo diagram edits. Follow-ups check the document revision before merging and preserve manual positions. Import and export architecture JSON from the studio. The browser saves diagrams locally; imported documents can be viewed without a model key.

`lib/architecture/asset-catalog.json` contains 228 curated Devicon technology records, with names, aliases, categories, asset paths, source versions and licensing metadata. Sixteen generic Lucide concepts cover vendor-neutral databases, cloud, networking, services and ML. SVGs are served individually from `public/architecture-assets`; they are not all embedded into the diagram or sent to the LLM. Regenerate with `pnpm assets:build`. Brand marks remain subject to their owners' usage policies; attribution is included with the assets.

The existing Groq key pool, rate-limit handling, streamed status, local saving, voice controls and optional Google Drive backup are retained. Older saved lessons can be opened as generic component cards with their original data retained; their former scientific visuals are not reproduced. Start a repository walkthrough to use grounded follow-ups.

## Configuration and storage

- `GROQ_API_KEY`, optional `_2` and `_3`: managed provider keys. Personal keys can instead be entered in the app. The explanation model is `openai/gpt-oss-120b` with validated JSON output.
- `BYOK_ENCRYPTION_SECRET`: at least 32 random characters in production; protects personal provider cookies. Local development creates `.chalkie-dev-secret`. Never commit that file.
- `CHALKIE_DATA_DIR`: private, writable persistent directory for parsed repository evidence; defaults to `.chalkie-data`. Snapshots expire after seven days and are isolated by an HttpOnly browser-owner cookie. A browser may retain up to 30 snapshots. Reset clears that browser's indexes and saved credentials.
- `GROQ_STT_MODEL`, `GROQ_TTS_MODEL`, `NEXT_PUBLIC_USE_GROQ_TTS`: optional voice settings. Device speech is the default.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`: optional existing Drive backup integration.

Repository evidence is stored on the app server and selected excerpts are sent to Groq to explain it. GitHub credentials are not used; old GitHub-token cookies are cleared on the next import, and the retired token endpoint no longer accepts credentials. Saved diagrams contain source excerpts and attached documentation and should be shared with the same care as that documentation. Sharing/exporting a diagram does not grant access to its server-side evidence index; another browser must index the public URL before asking follow-ups.

For deployment, a persistent private volume is required to retain indexes on ephemeral hosts. A replicated service needs shared storage and real organization authentication/authorization before team-wide index sharing. No deployment is performed by the build command.

## Deploy on Render

The included `render.yaml` points to `kushagarwal2910-lang/chalkie-2.0`, branch `main`. In Render, create a **Blueprint** from this repository. It creates a Node web service with a generated `BYOK_ENCRYPTION_SECRET`, the custom WebSocket-capable server, and `/api/health` as its health check. The blueprint defaults to a free instance for trying the app.

For a manually configured **Web Service**, use these same values:

```sh
# Build command
npm install -g pnpm@11.0.0 && pnpm install --frozen-lockfile --prod=false && pnpm run build

# Start command
node server.mjs
```

Set `NODE_VERSION=22.13.0`, `NODE_ENV=production`, `HOSTNAME=0.0.0.0`, and a stable random `BYOK_ENCRYPTION_SECRET` of at least 32 characters. Render supplies `PORT`. Add `GROQ_API_KEY` in Render's environment settings if you want a managed model key; otherwise enter a personal key in the app after deployment. Never put key values into this repository or the blueprint.

Render's [free instances](https://render.com/docs/free) have temporary storage and cannot attach a persistent disk. They can demonstrate indexing and explanations, but a restart, spin-down or deployment can remove the server evidence cache; paste the repository URL again to rebuild it. Saved browser diagrams remain available.

For ongoing use, choose a paid instance, attach a [persistent disk](https://render.com/docs/disks) at `/var/data/chalkie`, and set `CHALKIE_DATA_DIR=/var/data/chalkie`. This preserves evidence across deployments within Chalkie's seven-day retention window. Keep the encryption secret stable, since changing it invalidates saved provider credentials. A health check can pass without an LLM key; verify a complete repository walkthrough after adding one.

## Current boundaries

- Each import allows a 32 MiB ZIP, 50,000 entries, 120 blueprint files/1.8 MB, and up to 3,000 analyzed source files/32 MiB. Files are limited to 512,000 bytes. Initial code excerpts cover up to 160 prioritized files and 3 MiB/2,400 excerpts; the larger symbol map remains available for targeted lookup. At most two imports run concurrently. Oversized or unparsed files remain visible as mapped paths, without claiming complete symbol coverage.
- Follow-up lookup defaults to twelve files, 512,000 bytes each, two import hops and 40 seconds, within a 6,000-excerpt/7-million-character research ceiling. Exact file/line questions prioritize their requested region. No model calls are used for search or parsing. Explanation requests retain a 14 KB input cap and allow 4,000 completion tokens; deeper answers consume more of the existing Groq allowance.
- Helm templates are not rendered, remote Terraform modules are not downloaded and live infrastructure is not queried. Static syntax cannot establish all runtime behavior or undocumented business intent; remaining gaps are stated specifically, not hidden.
- Retrieval ranks paths, definitions and source text, follows imports and importers, and combines contribution guides with representative implementation for onboarding; it does not use an embedding database. Automatic diagrams are limited to 160 components and 320 connections; explore larger systems through focused follow-ups.
- Node overlap is corrected at layout/drag completion. Complex graphs can still have edge crossings; subsystem filtering and focused playback keep them readable.
- Public repositories only. Private repository authorization, organization accounts, GitHub App installation, shared workspaces and access audits are separate product work.

## Validation

```sh
pnpm test:architecture
pnpm typecheck
pnpm build
```

Architecture tests cover the allowlist, redaction, HCL/YAML/Docker parsing, public archive imports, commit provenance, size limits, corrupt archives, traversal/link rejection, cancellation, cache revalidation, model-output validation and repair, layout, follow-up merges, JSON round-trips, and index ownership/expiry. Model integration tests use controlled responses; a live Groq key is needed to verify actual generation. The production build also checks the generated page styles.

Main implementation: `lib/architecture/`, `components/chalk-canvas.tsx`, `/api/lesson`, `/api/follow-up`, and `/api/repository-access`.
