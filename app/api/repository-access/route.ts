import { cookies } from "next/headers";
import { z } from "zod";
import { byokEncryptionConfigured, encryptProviderCredentials } from "@/lib/provider-credentials";
import { githubToken } from "@/lib/architecture/index-store";
export const runtime = "nodejs";
export async function GET() { return Response.json({ connected: Boolean(await githubToken()) }, { headers: { "Cache-Control": "no-store" } }); }
export async function POST(request: Request) {
  const body = z.object({ token: z.string().trim().min(10).max(255) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ message: "Enter a valid GitHub token." }, { status: 400 });
  if (!byokEncryptionConfigured()) return Response.json({ message: "The server needs BYOK_ENCRYPTION_SECRET before storing private repository access." }, { status: 503 });
  const token = body.data.token;
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" }).catch(() => null);
  if (!response?.ok) return Response.json({ message: "GitHub could not validate this token. Check it and try again." }, { status: 400 });
  (await cookies()).set("chalkie_github", encryptProviderCredentials({ version: 1, groqKeys: [], githubToken: token, savedAt: Date.now() }), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 30 * 86400 });
  return Response.json({ connected: true });
}
export async function DELETE() { (await cookies()).delete("chalkie_github"); return Response.json({ connected: false }); }
