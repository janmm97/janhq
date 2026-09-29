// The desktop shortcut opens /enter?k=<key>; the right key becomes the joshq cookie the pages and API need.
import { HQ_COOKIE, ensureHqKey, sameSecret } from "@/lib/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const k = new URL(req.url).searchParams.get("k");
  const key = ensureHqKey();
  if (!k || !sameSecret(k, key)) return new Response("Open J/OS HQ from its desktop shortcut.", { status: 401, headers: { "cache-control": "no-store" } });
  return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store", "set-cookie": `${HQ_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/` } });
}
