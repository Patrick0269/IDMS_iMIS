export interface ClientIpSource {
  ip?: string | null | undefined;
  socket?: { remoteAddress?: string | null | undefined } | null | undefined;
}

/** Use Express's resolved address; do not trust a client-supplied forwarded header. */
export function getClientIp(request: ClientIpSource): string | null {
  return request.ip || request.socket?.remoteAddress || null;
}
