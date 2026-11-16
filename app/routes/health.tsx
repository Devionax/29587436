import db from "../db.server";

/**
 * Public liveness/readiness probe for hosting platforms and uptime monitors.
 * Reports only whether the app can reach its database; no tenant data and no
 * configuration details are exposed.
 */
export const loader = async () => {
  const headers = { "Cache-Control": "no-store" };

  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
};
