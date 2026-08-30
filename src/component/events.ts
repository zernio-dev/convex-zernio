import {
  isRecord,
  mapPlatformStatus,
  mapZernioPostStatus,
  normalizeZernioId,
  parseTimestamp,
  readArray,
  readBoolean,
  readRecord,
  readString,
  type PlatformTarget,
  type PostStatus,
} from "./shared.js";

const POST_EVENTS: readonly string[] = [
  "post.scheduled",
  "post.published",
  "post.failed",
  "post.partial",
  "post.cancelled",
  "post.platform.published",
  "post.platform.failed",
];

const ACCOUNT_EVENTS: readonly string[] = [
  "account.connected",
  "account.disconnected",
];

export function isConsumedPostEvent(event: string): boolean {
  return POST_EVENTS.includes(event);
}

export function isConsumedAccountEvent(event: string): boolean {
  return ACCOUNT_EVENTS.includes(event);
}

export function isPlatformEvent(event: string): boolean {
  return event.startsWith("post.platform.");
}

function buildTarget(args: {
  platform: string;
  accountId: string;
  status: unknown;
  platformPostId: string | null;
  publishedUrl: string | null;
  errorMessage: string | null;
  publishedAt: number | null;
}): PlatformTarget {
  return {
    platform: args.platform,
    accountId: args.accountId,
    status: mapPlatformStatus(args.status),
    ...(args.platformPostId !== null
      ? { platformPostId: args.platformPostId }
      : {}),
    ...(args.publishedUrl !== null ? { publishedUrl: args.publishedUrl } : {}),
    ...(args.errorMessage !== null ? { errorMessage: args.errorMessage } : {}),
    ...(args.publishedAt !== null ? { publishedAt: args.publishedAt } : {}),
  };
}

/**
 * Maps both wire shapes of a platform entry: the webhook projection
 * (`publishedUrl`, `error`) and the REST response (`platformPostUrl`,
 * `errorMessage`). An entry without an `accountId` inherits it from the
 * previous state for the same platform.
 */
export function platformTargetsFrom(
  entries: unknown[],
  previous: PlatformTarget[],
): PlatformTarget[] {
  const targets: PlatformTarget[] = [];
  for (const entry of entries) {
    const platform = readString(entry, "platform");
    if (platform === null) {
      continue;
    }
    const accountId =
      normalizeZernioId(isRecord(entry) ? entry.accountId : null) ??
      previous.find((target) => target.platform === platform)?.accountId ??
      "";
    targets.push(
      buildTarget({
        platform,
        accountId,
        status: isRecord(entry) ? entry.status : null,
        platformPostId: readString(entry, "platformPostId"),
        publishedUrl:
          readString(entry, "publishedUrl") ??
          readString(entry, "platformPostUrl"),
        errorMessage:
          readString(entry, "error") ?? readString(entry, "errorMessage"),
        publishedAt: parseTimestamp(isRecord(entry) ? entry.publishedAt : null),
      }),
    );
  }
  return targets;
}

/**
 * Overwrites the entry a `post.platform.*` event names from its fresher
 * top-level `platform` block, which is more recent than the embedded `post`
 * projection for that one target.
 */
export function applyPlatformBlock(args: {
  targets: PlatformTarget[];
  payload: unknown;
  event: string;
  eventAt: number;
}): PlatformTarget[] {
  const block = readRecord(args.payload, "platform");
  const platform = readString(block, "name");
  if (block === null || platform === null) {
    return args.targets;
  }
  const accountId = readString(
    readRecord(args.payload, "account"),
    "accountId",
  );
  const index = args.targets.findIndex(
    (target) =>
      target.platform === platform &&
      (accountId === null ||
        target.accountId === accountId ||
        target.accountId === ""),
  );
  const previous = index >= 0 ? args.targets[index] : undefined;
  const updated = buildTarget({
    platform,
    accountId: accountId ?? previous?.accountId ?? "",
    status: block.status,
    platformPostId:
      readString(block, "platformPostId") ?? previous?.platformPostId ?? null,
    publishedUrl:
      readString(block, "publishedUrl") ?? previous?.publishedUrl ?? null,
    errorMessage: readString(block, "error") ?? previous?.errorMessage ?? null,
    publishedAt:
      args.event === "post.platform.published"
        ? args.eventAt
        : (previous?.publishedAt ?? null),
  });
  if (index < 0) {
    return [...args.targets, updated];
  }
  const merged = [...args.targets];
  merged[index] = updated;
  return merged;
}

/**
 * Returns `null` for `status` when the event carries no post-level transition,
 * in which case the stored status is kept.
 */
export function postTransitionFor(
  event: string,
  payload: unknown,
): { status: PostStatus | null; finalized: boolean } {
  switch (event) {
    case "post.scheduled":
      return { status: "scheduled", finalized: false };
    case "post.published":
      return { status: "published", finalized: true };
    case "post.partial":
      return { status: "partial", finalized: true };
    case "post.failed":
      return { status: "failed", finalized: true };
    case "post.cancelled":
      return { status: "cancelled", finalized: true };
    default: {
      const mapped = mapZernioPostStatus(
        readString(readRecord(payload, "post"), "status"),
      );
      // "publishing" is still in flight, so a platform event never adopts it.
      return {
        status: mapped === "submitting" ? null : mapped,
        finalized: false,
      };
    }
  }
}

export function firstPlatformError(targets: PlatformTarget[]): string | null {
  for (const target of targets) {
    if (target.status === "failed" && target.errorMessage !== undefined) {
      return target.errorMessage;
    }
  }
  return null;
}

export type AccountEventBlock = {
  zernioAccountId: string;
  zernioProfileId: string;
  platform: string;
  username: string;
  displayName: string | null;
  disconnectionType: "intentional" | "unintentional" | null;
  reason: string | null;
};

export function accountBlockFrom(payload: unknown): AccountEventBlock | null {
  const account = readRecord(payload, "account");
  const zernioAccountId = readString(account, "accountId");
  const zernioProfileId = normalizeZernioId(
    isRecord(account) ? account.profileId : null,
  );
  const platform = readString(account, "platform");
  if (
    zernioAccountId === null ||
    zernioProfileId === null ||
    platform === null
  ) {
    return null;
  }
  const disconnectionType = readString(account, "disconnectionType");
  return {
    zernioAccountId,
    zernioProfileId,
    platform,
    username: readString(account, "username") ?? "",
    displayName: readString(account, "displayName"),
    disconnectionType:
      disconnectionType === "intentional" ||
      disconnectionType === "unintentional"
        ? disconnectionType
        : null,
    reason: readString(account, "reason"),
  };
}

export type AccountUpsert = {
  zernioAccountId: string;
  platform: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isActive: boolean;
};

export function accountUpsertsFrom(entries: unknown[]): AccountUpsert[] {
  const accounts: AccountUpsert[] = [];
  for (const entry of entries) {
    const zernioAccountId = normalizeZernioId(
      isRecord(entry) ? entry._id : null,
    );
    const platform = readString(entry, "platform");
    if (zernioAccountId === null || platform === null) {
      continue;
    }
    const displayName = readString(entry, "displayName");
    const avatarUrl = readString(entry, "profilePicture");
    accounts.push({
      zernioAccountId,
      platform,
      // Zernio only requires _id, platform, profileId and isActive.
      username: readString(entry, "username") ?? "",
      ...(displayName !== null ? { displayName } : {}),
      ...(avatarUrl !== null ? { avatarUrl } : {}),
      isActive: readBoolean(entry, "isActive") ?? true,
    });
  }
  return accounts;
}

export function postProjectionPlatforms(payload: unknown): unknown[] {
  return readArray(readRecord(payload, "post"), "platforms");
}

export function postProjectionId(payload: unknown): string | null {
  return readString(readRecord(payload, "post"), "id");
}
