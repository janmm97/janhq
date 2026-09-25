// Next.js calls register() once when the server starts: boot HQ (database, restart reconciliation,
// first health report) before the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureBoot } = await import("./lib/server/boot");
    await ensureBoot();
  }
}
