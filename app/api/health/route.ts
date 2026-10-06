import { resolveProviderCredentials } from "@/lib/provider-credentials";

export const dynamic = "force-dynamic";

export async function GET() {
  const providers = await resolveProviderCredentials();
  return Response.json({
    ok: true,
    mode: providers.groqKeys.length ? "live" : "needs_keys",
    services: {
      groq: providers.groqKeys.length > 0,
      groqKeyCount: providers.groqKeys.length,
      groqSource: providers.source,
      googleDrive: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.SESSION_SECRET),
      repositoryIngestion: true,
    },
    model: "openai/gpt-oss-120b",
  });
}
