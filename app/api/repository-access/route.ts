import { cookies } from "next/headers";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ connected: false, publicOnly: true, tokenRequired: false }, { headers: { "Cache-Control": "no-store" } });
}

/** Retire the old token form without accepting or contacting GitHub with credentials. */
export async function POST() {
  (await cookies()).delete("chalkie_github");
  return Response.json({ code: "PUBLIC_REPOSITORIES_ONLY", message: "Chalkie imports public repositories without a GitHub token. Private repositories are not supported." }, { status: 410 });
}

export async function DELETE() {
  (await cookies()).delete("chalkie_github");
  return Response.json({ connected: false, publicOnly: true });
}
