import { ConvexError } from "convex/values";
import { isRecord, readString, type PlatformTarget } from "./shared.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ZernioResponse = {
  status: number;
  ok: boolean;
  data: unknown;
  retryAfter: string | null;
};

export function joinUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function zernioFetch(args: {
  baseUrl: string;
  apiKey: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<ZernioResponse> {
  const hasBody = args.body !== undefined;
  const response = await fetch(joinUrl(args.baseUrl, args.path, args.query), {
    method: args.method,
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...args.headers,
    },
    body: hasBody ? JSON.stringify(args.body) : undefined,
  });
  return {
    status: response.status,
    ok: response.ok,
    data: parseBody(await response.text()),
    retryAfter: response.headers.get("retry-after"),
  };
}

export function zernioErrorMessage(
  response: ZernioResponse,
  fallback: string,
): string {
  const message =
    readString(response.data, "error") ?? readString(response.data, "message");
  if (message !== null) {
    return message;
  }
  if (typeof response.data === "string" && response.data.length > 0) {
    return response.data;
  }
  return fallback;
}

/**
 * Throws for a Zernio non-2xx. The thrown `ConvexError` data is what the client
 * class turns back into a `ZernioApiError`.
 */
export function zernioApiError(
  response: ZernioResponse,
  fallback: string,
): ConvexError<{
  kind: string;
  status: number;
  code?: string;
  param?: string;
  message: string;
}> {
  const code = readString(response.data, "code");
  const param = readString(response.data, "param");
  return new ConvexError({
    kind: "zernio_api_error",
    status: response.status,
    ...(code !== null ? { code } : {}),
    ...(param !== null ? { param } : {}),
    message: zernioErrorMessage(response, fallback),
  });
}

/**
 * Permanent for retry purposes: any 4xx except 408 and 429, which Zernio itself
 * treats as retryable.
 */
export function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function buildCreatePostBody(args: {
  content: string;
  title?: string;
  mediaUrls?: string[];
  timezone?: string;
  scheduledFor?: number;
  platforms: PlatformTarget[];
  testMode: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: args.content,
    platforms: args.platforms.map((target) => ({
      platform: target.platform,
      accountId: target.accountId,
    })),
  };
  if (args.title !== undefined) {
    body.title = args.title;
  }
  if (args.mediaUrls !== undefined && args.mediaUrls.length > 0) {
    // Zernio auto-detects the media type from the URL extension.
    body.mediaItems = args.mediaUrls.map((url) => ({ url }));
  }
  if (args.timezone !== undefined) {
    body.timezone = args.timezone;
  }
  if (args.testMode) {
    // A draft must carry neither scheduledFor nor publishNow, or Zernio queues it.
    body.isDraft = true;
    return body;
  }
  if (args.scheduledFor !== undefined) {
    body.scheduledFor = new Date(args.scheduledFor).toISOString();
    return body;
  }
  // Sending no scheduling directive at all silently auto-drafts the post.
  body.publishNow = true;
  return body;
}

export function readSocialAccounts(data: unknown): unknown[] {
  if (!isRecord(data)) {
    return [];
  }
  return Array.isArray(data.accounts) ? data.accounts : [];
}
