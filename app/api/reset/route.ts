import { cookies } from "next/headers";
import { BYOK_COOKIE } from "@/lib/provider-credentials";
import { clearRepositoryIndexes, repositoryOwner } from "@/lib/architecture/index-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearRepositoryIndexes(await repositoryOwner());
  // Provider cooldowns are real limits, shared across requests using those keys.
  // Clearing a workspace must not reset them for this user or other users.

  // 3. Clear the BYOK cookie
  const cookieStore = await cookies();
  cookieStore.delete(BYOK_COOKIE);
  cookieStore.delete("chalkie_github");

  return Response.json({
    ok: true,
    message: "Your repository indexes and personal credential cookies have been cleared. Provider retry windows are unchanged.",
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
