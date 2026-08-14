export const DEPLOYMENT_HEALTH_PATH = "/.well-known/atrinik-deployment-health";

/** Match only the fixed, credential-free production health request. */
export function isDeploymentHealthRequest(
  request: Request,
  authority: string,
): boolean {
  const url = new URL(request.url);
  return request.method === "GET" &&
    url.protocol === "https:" &&
    url.hostname === authority &&
    url.port === "" &&
    url.pathname === DEPLOYMENT_HEALTH_PATH &&
    url.search === "";
}

export function deploymentHealthResponse(
  actual: string,
  expected: "publisher" | "rendezvous",
): Response {
  if (actual !== expected) throw new Error("Deployment health role mismatch");
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
