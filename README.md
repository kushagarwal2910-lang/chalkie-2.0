# Chalkie

Chalkie turns a GitHub repository's architectural blueprints into a narrated, interactive diagram. It helps developers onboard, engineering teams understand system boundaries, and product or leadership audiences follow the architecture in plain language.

## Run locally

Requires Node.js 22.13+ and pnpm 11.

```sh
pnpm install
pnpm dev
```

Open the local URL printed by the server. Add a Groq key through **Provider keys**, or set `GROQ_API_KEY` in `.env.local`. Paste a GitHub repository URL and choose an audience. For private repositories, open **Repository access** and supply a fine-grained GitHub token restricted to the selected repositories, with Contents read access. Public repositories also benefit from an authenticated token's API allowance.

The app generates an initial walkthrough automatically. Follow-up questions retrieve evidence from the same indexed commit, then either focus existing components or append new components and narration. Voice input uses Groq transcription; narration uses device speech by default, with optional Groq audio.

## What is indexed

The ingestion engine lists the repository tree, pins it to a commit, and fetches only candidate blueprint blobs. It does not execute repository files, install their dependencies, or ingest application source files such as `app.ts`, `auth.py`, and `utils.js`.

- Dockerfiles and Compose: images, services, exposed ports, declared networks, volumes and startup dependencies.
- Terraform HCL/JSON: resources, modules, providers and unresolved references.
- Kubernetes and CloudFormation YAML/JSON: resource declarations and intrinsic references. Unrelated YAML is discarded after structural classification.
- Dependency manifests: `package.json`, requirements files, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, and `Gemfile`.
- High-level documents: README, ARCHITECTURE, AGENTS, onboarding, deployment, runbooks, and architecture decision records, including nested directories.

Application source, lockfiles, vendored/build directories, environment files, state files, and symlinks are excluded. Obvious credential values are redacted before storage. Redaction is best effort: do not put credentials into repository documentation. Repository text, including AGENTS instructions, is untrusted evidence for the explanation model.

Blueprints describe **declared or documented architecture**, not verified production state. A package dependency does not prove a deployed service; Compose `depends_on` describes startup order, not request flow. The model is instructed to preserve those distinctions and cite evidence. Citations are validated references, not a guarantee that every generated interpretation is correct.

## Canvas and LLM responsibilities

The canvas uses React Flow with Chalkie's component cards, technology visuals, source inspector and narration controls. ELK calculates node positions; deterministic routing places orthogonal connections and labels. The model supplies semantic JSON: nodes, relationships, evidence IDs, registered asset IDs and explanation steps. It does not supply coordinates, executable graphics or arbitrary image URLs.

You can pan and zoom, drag components with collision correction, connect handles, edit labels, select another visual, filter by subsystem, auto-arrange, and undo or redo diagram edits. Follow-ups check the document revision before merging and preserve manual positions. Import and export architecture JSON from the studio. The browser saves diagrams locally; imported documents can be viewed without a model key.

`lib/architecture/asset-catalog.json` contains 228 curated Devicon technology records, with names, aliases, categories, asset paths, source versions and licensing metadata. Sixteen generic Lucide concepts cover vendor-neutral databases, cloud, networking, services and ML. SVGs are served individually from `public/architecture-assets`; they are not all embedded into the diagram or sent to the LLM. Regenerate with `pnpm assets:build`. Brand marks remain subject to their owners' usage policies; attribution is included with the assets.

The existing Groq key pool, rate-limit handling, streamed status, local saving, voice controls and optional Google Drive backup are retained. Older saved lessons can be opened as generic component cards with their original data retained; their former scientific visuals are not reproduced. Start a repository walkthrough to use grounded follow-ups.

## Configuration and storage

- `GROQ_API_KEY`, optional `_2` and `_3`: managed provider keys. Personal keys can instead be entered in the app. The explanation model is `openai/gpt-oss-120b` with validated JSON output.
- `BYOK_ENCRYPTION_SECRET`: at least 32 random characters in production; protects personal provider/GitHub cookies. Local development creates `.chalkie-dev-secret`. Never commit that file.
- `CHALKIE_DATA_DIR`: private, writable persistent directory for parsed repository evidence; defaults to `.chalkie-data`. Snapshots expire after seven days and are isolated by an HttpOnly browser-owner cookie. A browser may retain up to 30 snapshots. Reset clears that browser's indexes and saved credentials.
- `GROQ_STT_MODEL`, `GROQ_TTS_MODEL`, `NEXT_PUBLIC_USE_GROQ_TTS`: optional voice settings. Device speech is the default.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`: optional existing Drive backup integration.

Repository evidence is stored on the app server and selected excerpts are sent to Groq to explain it. GitHub tokens stay in encrypted HttpOnly cookies and are used only for GitHub requests. Saved diagrams contain source excerpts and should be shared with the same care as repository documentation. Sharing/exporting a diagram does not grant access to its server-side evidence index; another browser must index the URL with its own repository access before asking follow-ups.

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

For ongoing use, choose a paid instance, attach a [persistent disk](https://render.com/docs/disks) at `/var/data/chalkie`, and set `CHALKIE_DATA_DIR=/var/data/chalkie`. This preserves evidence across deployments within Chalkie's seven-day retention window. Keep the encryption secret stable, since changing it invalidates saved provider and GitHub credentials. A health check can pass without an LLM key; verify a complete repository walkthrough after adding one.

## Current boundaries

- Each scan is bounded to 120 candidate files, 128 KB per file, about 1.8 MB of content, and 180 GitHub API calls. Partial coverage and parse failures are displayed. Large monorepos may require a later scoped indexing workflow.
- Helm templates are not rendered, Terraform remote modules are not downloaded, and live cloud state is not queried. Unsupported templates yield coverage warnings. Follow-ups cannot reveal business logic absent from the allowed blueprints.
- Retrieval currently ranks bounded evidence lexically; it does not use an embedding database. Automatic diagrams are limited to 160 components and 320 connections; large systems should be explored through successive focused explanations.
- Node overlap is corrected at layout/drag completion. Complex graphs can still have edge crossings; subsystem filtering and focused playback keep them readable.
- Repository access currently uses personal fine-grained tokens. Organization accounts, GitHub App installation, shared workspaces and access audits are separate product work.

## Validation

```sh
pnpm test:architecture
pnpm typecheck
pnpm build
```

Architecture tests cover the allowlist, redaction, HCL/YAML/Docker parsing, immutable GitHub scans, truncated trees, model-output validation and repair, layout, follow-up merges, JSON round-trips, and index ownership/expiry. Model integration tests use controlled responses; a live Groq key is needed to verify actual generation. The production build also checks the generated page styles.

Main implementation: `lib/architecture/`, `components/chalk-canvas.tsx`, `/api/lesson`, `/api/follow-up`, and `/api/repository-access`.
