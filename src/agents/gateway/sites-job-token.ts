import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "../../app/errors/application-error.js";

export interface SitesJobTokenClaims {
  readonly jobId: string;
  readonly siteId: string;
  readonly expiresAt: number;
  readonly operations: readonly ["createResponse"];
  readonly nonce: string;
}
export class SitesJobTokenService {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}
  issue(jobId: string, siteId: string, ttlMs = 15 * 60_000): string {
    const claims: SitesJobTokenClaims = {
      jobId,
      siteId,
      expiresAt: Date.now() + ttlMs,
      operations: ["createResponse"],
      nonce: randomBytes(16).toString("hex"),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }
  verify(token: string | undefined, jobId: string, siteId: string): SitesJobTokenClaims {
    const [payload, signature] = token?.split(".") ?? [];
    if (!payload || !signature)
      throw new ApplicationError("VALIDATION_FAILED", "Missing or malformed Sites job token");
    const expected = this.#sign(payload);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new ApplicationError("VALIDATION_FAILED", "Invalid Sites job token");
    let claims: SitesJobTokenClaims;
    try {
      claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as SitesJobTokenClaims;
    } catch {
      throw new ApplicationError("VALIDATION_FAILED", "Invalid Sites job token payload");
    }
    if (claims.expiresAt <= Date.now())
      throw new ApplicationError("VALIDATION_FAILED", "Expired Sites job token");
    if (claims.jobId !== jobId || claims.siteId !== siteId)
      throw new ApplicationError("VALIDATION_FAILED", "Sites job token scope mismatch");
    return claims;
  }
  #sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
