import type { NextFunction, Request, Response } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";

export interface DashboardIdentity {
  uid: string;
  email: string;
  name: string;
}

export interface TokenVerifier {
  verifyIdToken(token: string): Promise<DecodedIdToken>;
}

export type AuthenticatedRequest = Request & { dashboardUser?: DashboardIdentity };

export function dashboardAuth(
  verifier: TokenVerifier,
  allowedEmails: readonly string[],
) {
  const allowlist = new Set(allowedEmails.map((email) => email.toLowerCase()));
  return async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const match = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
    if (!match?.[1]) {
      response.status(401).json({ error: "Firebase sign-in required" });
      return;
    }

    try {
      const decoded = await verifier.verifyIdToken(match[1]);
      const email = decoded.email?.toLowerCase();
      if (!email || (allowlist.size > 0 && !allowlist.has(email))) {
        response.status(403).json({ error: "This account is not allowed" });
        return;
      }
      request.dashboardUser = {
        uid: decoded.uid,
        email,
        name: decoded.name ?? email,
      };
      next();
    } catch {
      response.status(401).json({ error: "Invalid or expired Firebase token" });
    }
  };
}
