import { createHmac, timingSafeEqual } from "node:crypto";

export const EVAL_ACCESS_COOKIE = "assessment_eval_access";
const SESSION_MESSAGE = "assessment-eval-labeling-v1";

function accessCode(): string | null {
  const value = process.env.EVAL_ACCESS_CODE?.trim();
  return value && value.length >= 12 ? value : null;
}

function digest(value: string): Buffer {
  return createHmac("sha256", SESSION_MESSAGE).update(value).digest();
}

function sessionToken(code: string): string {
  return createHmac("sha256", code).update(SESSION_MESSAGE).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

export function evalAccessConfigured(): boolean {
  return accessCode() !== null;
}

export function authorizeEvalCode(candidate: string): string | null {
  const configured = accessCode();
  if (!configured || !equal(candidate, configured)) return null;
  return sessionToken(configured);
}

export function isEvalAccessTokenValid(candidate: string | undefined): boolean {
  const configured = accessCode();
  if (!configured || !candidate) return false;
  return equal(candidate, sessionToken(configured));
}

export function evalAccessTokenFromRequest(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === EVAL_ACCESS_COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function isEvalRequestAuthorized(request: Request): boolean {
  return isEvalAccessTokenValid(evalAccessTokenFromRequest(request));
}
