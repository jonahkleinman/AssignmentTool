import { NextResponse } from "next/server";

import {
  authorizeEvalCode,
  EVAL_ACCESS_COOKIE,
  evalAccessConfigured,
} from "@/lib/eval/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!evalAccessConfigured()) {
    return Response.json({ error: "Evaluation access is not configured." }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const code =
    typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
      ? body.code
      : "";
  const token = authorizeEvalCode(code);
  if (!token) {
    return Response.json({ error: "That access code is not valid." }, { status: 401 });
  }

  const response = NextResponse.json({ authorized: true });
  response.cookies.set({
    name: EVAL_ACCESS_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return response;
}
