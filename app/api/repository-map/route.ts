import type { NextRequest } from "next/server";
import { repositoryOwner, loadRepositoryIndex } from "@/lib/architecture/index-store";
import { listRepositoryMap } from "@/lib/architecture/repository-map";
import { providerFailureResponse } from "@/lib/provider-response";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  try {
    const index = await loadRepositoryIndex(params.get("indexId") ?? "", await repositoryOwner());
    const offset = Number(params.get("offset") ?? 0);
    return Response.json(listRepositoryMap(index, (params.get("q") ?? "").slice(0, 250), Number.isFinite(offset) ? offset : 0), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return providerFailureResponse(error); }
}
