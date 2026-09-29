// The pages' half of the access lock (./access). A layout renders its children only for a browser that
// came in through the desktop shortcut; reading the request's cookies keeps every gated page dynamic.
import { cookies, headers } from "next/headers";
import { HQ_COOKIE, ensureHqKey, pageAccessOk } from "./access";
import { serverPort } from "./env";

export async function AccessGate({ children }: { children: React.ReactNode }) {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  if (pageAccessOk({ cookie: jar.get(HQ_COOKIE)?.value, host: h.get("host") }, ensureHqKey(), serverPort())) return <>{children}</>;
  return (
    <main className="grid min-h-screen place-items-center px-4 text-center text-[14px] text-silver" data-testid="access-locked">
      Open J/OS HQ from its desktop shortcut.
    </main>
  );
}
