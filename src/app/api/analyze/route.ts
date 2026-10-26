import { NextResponse } from "next/server";
import { AnalysisError, toPublicError } from "@/lib/errors";
import { analyzePullRequest } from "@/lib/pipeline";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4_096;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 8;

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  return `analyze:${ip || "local"}`;
}

function errorResponse(error: unknown) {
  const publicError = toPublicError(error);
  const status = error instanceof AnalysisError ? error.status : 500;
  return NextResponse.json({ error: publicError }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const limit = rateLimit(clientKey(request), { windowMs: WINDOW_MS, max: MAX_REQUESTS });
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: {
          code: "rate_limited",
          message: "Too many analyses from this address. Try again shortly.",
          hint: `Retry in about ${limit.retryAfterSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(limit.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_url", message: "Send a JSON body with a pull request URL." } },
      { status: 400 },
    );
  }

  // Enforced on the decoded body: request headers are client-supplied and
  // cannot be trusted to reflect the real size.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: "invalid_url", message: "Request body is too large." } },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_url", message: "Send a JSON body with a pull request URL." } },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: { code: "invalid_url", message: "Send a JSON object with a pull request URL." } },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : "";
  const demo = record.demo === true;

  try {
    const report = await analyzePullRequest({ url, demo });
    return NextResponse.json(report, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-RateLimit-Limit": String(MAX_REQUESTS),
        "X-RateLimit-Remaining": String(limit.remaining),
      },
    });
  } catch (error) {
    if (!(error instanceof AnalysisError)) {
      console.error("PR Passport analysis failed", error instanceof Error ? error.message : error);
    }
    return errorResponse(error);
  }
}