import { v, type Infer } from "convex/values";

export const vPostStatus = v.union(
  v.literal("pending"),
  v.literal("submitting"),
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("published"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

// The Zernio model enum from models/Post.ts, which is wider than the spec prose.
export const vPlatformStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("uploading"),
  v.literal("published"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const vPlatformTarget = v.object({
  platform: v.string(),
  accountId: v.string(),
  status: vPlatformStatus,
  platformPostId: v.optional(v.string()),
  publishedUrl: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  publishedAt: v.optional(v.number()),
});

// Carries no secrets: it is persisted in the component's lastOptions table.
export const vRuntimeOptions = v.object({
  baseUrl: v.string(),
  testMode: v.boolean(),
  onPostEvent: v.optional(v.string()),
  onAccountEvent: v.optional(v.string()),
});

export const vPostEventArgs = v.object({
  eventId: v.string(),
  event: v.string(),
  postId: v.union(v.null(), v.string()),
  zernioPostId: v.string(),
  status: vPostStatus,
  platform: v.union(v.null(), v.string()),
  platforms: v.array(vPlatformTarget),
  errorMessage: v.union(v.null(), v.string()),
  receivedAt: v.number(),
  payload: v.any(),
});

export const vAccountEventArgs = v.object({
  eventId: v.string(),
  event: v.string(),
  accountId: v.string(),
  zernioAccountId: v.string(),
  zernioProfileId: v.string(),
  platform: v.string(),
  username: v.string(),
  displayName: v.union(v.null(), v.string()),
  isActive: v.boolean(),
  disconnectionType: v.union(
    v.null(),
    v.literal("intentional"),
    v.literal("unintentional"),
  ),
  reason: v.union(v.null(), v.string()),
  receivedAt: v.number(),
  payload: v.any(),
});

export type PostStatus = Infer<typeof vPostStatus>;
export type PlatformStatus = Infer<typeof vPlatformStatus>;
export type PlatformTarget = Infer<typeof vPlatformTarget>;
export type RuntimeOptions = Infer<typeof vRuntimeOptions>;
export type PostEventArgs = Infer<typeof vPostEventArgs>;
export type AccountEventArgs = Infer<typeof vAccountEventArgs>;

const TERMINAL_POST_STATUSES: readonly PostStatus[] = [
  "draft",
  "published",
  "partial",
  "failed",
  "cancelled",
];

export function isTerminalPostStatus(status: PostStatus): boolean {
  return TERMINAL_POST_STATUSES.includes(status);
}

const PLATFORM_STATUSES: readonly string[] = [
  "pending",
  "processing",
  "uploading",
  "published",
  "failed",
  "cancelled",
];

export function mapPlatformStatus(value: unknown): PlatformStatus {
  if (typeof value !== "string") {
    return "pending";
  }
  if (PLATFORM_STATUSES.includes(value)) {
    return value as PlatformStatus;
  }
  // The spec prose says "publishing" where the model says "processing".
  return value === "publishing" ? "processing" : "pending";
}

const ZERNIO_POST_STATUS: Record<string, PostStatus> = {
  draft: "draft",
  scheduled: "scheduled",
  publishing: "submitting",
  published: "published",
  partial: "partial",
  failed: "failed",
  cancelled: "cancelled",
};

export function mapZernioPostStatus(value: unknown): PostStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  return ZERNIO_POST_STATUS[value] ?? null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

export function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return typeof nested === "string" ? nested : null;
}

export function readBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return typeof nested === "boolean" ? nested : null;
}

export function readArray(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const nested = value[key];
  return Array.isArray(nested) ? nested : [];
}

/**
 * Zernio ids arrive either as a raw string or as an expanded object under `_id`
 * (both `SocialAccount.profileId` and `PlatformTarget.accountId` are polymorphic).
 */
export function normalizeZernioId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return readString(value, "_id");
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * FNV-1a rather than SHA-256 because a Convex mutation cannot await
 * `crypto.subtle`, and the idempotency key has to be derived synchronously.
 */
export function fnv1a64hex(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, "0");
}

export function deriveIdempotencyKey(args: {
  zernioProfileId: string;
  accountIds: string[];
  content: string;
  title?: string;
  mediaUrls?: string[];
  scheduledFor?: number;
  testMode: boolean;
}): string {
  const parts = [
    args.zernioProfileId,
    [...args.accountIds].sort().join(","),
    args.content,
    args.title ?? "",
    (args.mediaUrls ?? []).join(","),
    args.scheduledFor ?? "now",
    args.testMode,
  ].join("|");
  return `zc_${fnv1a64hex(parts)}`;
}
