import { isRateLimitError } from "@convex-dev/rate-limiter";
import {
  actionGeneric,
  createFunctionHandle,
  httpActionGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  Auth,
  FunctionReference,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpRouter,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  isRecord,
  readString,
  vAccountEventArgs,
  vPostEventArgs,
  type AccountEventArgs,
  type PostEventArgs,
  type RuntimeOptions,
} from "../component/shared.js";
import { verifyZernioSignature } from "./signature.js";

export { computeZernioSignature, verifyZernioSignature } from "./signature.js";
export { vAccountEventArgs, vPostEventArgs };
export type { AccountEventArgs, PostEventArgs };

const DEFAULT_BASE_URL = "https://zernio.com/api";
const DEFAULT_HTTP_PREFIX = "/zernio";

export type ZernioPostStatus =
  | "pending"
  | "submitting"
  | "draft"
  | "scheduled"
  | "published"
  | "partial"
  | "failed"
  | "cancelled";

export type ZernioPlatformStatus =
  "pending" | "processing" | "uploading" | "published" | "failed" | "cancelled";

export type ZernioPlatformTarget = {
  platform: string;
  accountId: string;
  status: ZernioPlatformStatus;
  platformPostId?: string;
  publishedUrl?: string;
  errorMessage?: string;
  publishedAt?: number;
};

export type ZernioPost = NonNullable<
  FunctionReturnType<ComponentApi["lib"]["getPost"]>
>;
export type ZernioAccount = FunctionReturnType<
  ComponentApi["lib"]["listAccounts"]
>[number];
export type ZernioPostStatusSummary = NonNullable<
  FunctionReturnType<ComponentApi["lib"]["getPostStatus"]>
>;

export type ZernioOptions = {
  /** Defaults to `process.env.ZERNIO_API_KEY`, read on every call. */
  apiKey?: string;
  /** Defaults to `process.env.ZERNIO_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** Defaults to `process.env.ZERNIO_BASE_URL`, then `https://zernio.com/api`. */
  baseUrl?: string;
  /** Single-tenant profile. Defaults to `process.env.ZERNIO_PROFILE_ID`. */
  profileId?: string;
  /** Supplying this switches the component to multi-tenant mode. */
  getUserInfo?: (ctx: {
    auth: Auth;
  }) => Promise<{ userId: string; email?: string }>;
  onPostEvent?: FunctionReference<"mutation", "internal", PostEventArgs>;
  onAccountEvent?: FunctionReference<"mutation", "internal", AccountEventArgs>;
  /** Defaults to TRUE: posts are created as Zernio drafts, never published. */
  testMode?: boolean;
  /** Defaults to "/zernio". */
  httpPrefix?: string;
  /** Workpool parallelism for post submission. Defaults to 5. */
  maxParallelism?: number;
};

export class ZernioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZernioError";
  }
}

export class ZernioApiError extends ZernioError {
  readonly status: number;
  readonly code: string | undefined;

  constructor(args: { status: number; code?: string; message: string }) {
    super(args.message);
    this.name = "ZernioApiError";
    this.status = args.status;
    this.code = args.code;
  }
}

export function isZernioApiError(error: unknown): error is ZernioApiError {
  return error instanceof ZernioApiError;
}

function toZernioError(error: unknown): unknown {
  if (isRateLimitError(error)) {
    return new ZernioApiError({
      status: 429,
      code: "rate_limited",
      message: `Zernio rate limit reached, retry in ${Math.ceil(error.data.retryAfter / 1000)}s`,
    });
  }
  if (!(error instanceof ConvexError) || !isRecord(error.data)) {
    return error;
  }
  const kind = readString(error.data, "kind");
  if (kind === null || !kind.startsWith("zernio_")) {
    return error;
  }
  const message = readString(error.data, "message") ?? error.message;
  if (kind !== "zernio_api_error") {
    return new ZernioError(message);
  }
  const status = error.data.status;
  const code = readString(error.data, "code");
  return new ZernioApiError({
    status: typeof status === "number" ? status : 500,
    ...(code !== null ? { code } : {}),
    message,
  });
}

type Tenant = {
  userId?: string;
  zernioProfileId?: string;
  profileName?: string;
};

function tenantArgs(tenant: Tenant): {
  userId?: string;
  zernioProfileId?: string;
} {
  return {
    ...(tenant.userId !== undefined ? { userId: tenant.userId } : {}),
    ...(tenant.zernioProfileId !== undefined
      ? { zernioProfileId: tenant.zernioProfileId }
      : {}),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readHeader(
  request: Request,
  name: string,
  legacyName: string,
): string | null {
  return request.headers.get(name) ?? request.headers.get(legacyName);
}

const MISMATCH = Symbol("header contradicts the signed body");

function signedField(
  request: Request,
  payload: unknown,
  field: { key: string; header: string; legacyHeader: string },
): string | null | typeof MISMATCH {
  const signed = readString(payload, field.key);
  const header = readHeader(request, field.header, field.legacyHeader);
  if (signed === null) {
    return header;
  }
  if (header !== null && header !== signed) {
    return MISMATCH;
  }
  return signed;
}

export class Zernio {
  constructor(
    public component: ComponentApi,
    public options: ZernioOptions = {},
  ) {}

  /**
   * Mounts `POST <httpPrefix>/webhook` (default `/zernio/webhook`). The handler
   * verifies the HMAC over the raw body and replies 200 to anything it accepts,
   * including replays and events the component does not consume.
   */
  registerRoutes(http: HttpRouter): void {
    http.route({
      path: `${this.options.httpPrefix ?? DEFAULT_HTTP_PREFIX}/webhook`,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const rawBody = await request.text();
        const secret =
          this.options.webhookSecret ?? process.env.ZERNIO_WEBHOOK_SECRET;
        // Zernio sends no signature header when the subscription has no
        // secret, so accepting unsigned bodies would be an open write endpoint.
        if (secret === undefined || secret.length === 0) {
          return jsonResponse(500, {
            error: "ZERNIO_WEBHOOK_SECRET is not configured",
          });
        }
        const signature = readHeader(
          request,
          "X-Zernio-Signature",
          "X-Late-Signature",
        );
        if (signature === null) {
          return jsonResponse(401, { error: "Missing signature" });
        }
        if (!(await verifyZernioSignature({ rawBody, signature, secret }))) {
          return jsonResponse(401, { error: "Invalid signature" });
        }
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return jsonResponse(400, { error: "Invalid JSON body" });
        }
        // The signature covers the body and nothing else, so the event name and
        // the id the dedup key is built from are read from the body. The
        // headers are an unsigned copy: they only fill in a body that lacks the
        // field, and a header that contradicts the body is rejected rather than
        // trusted, because one captured delivery could otherwise be replayed
        // forever under new ids and relabelled as a different event.
        const event = signedField(request, payload, {
          key: "event",
          header: "X-Zernio-Event",
          legacyHeader: "X-Late-Event",
        });
        const eventId = signedField(request, payload, {
          key: "id",
          header: "X-Zernio-Event-Id",
          legacyHeader: "X-Late-Event-Id",
        });
        if (event === null || eventId === null) {
          return jsonResponse(400, { error: "Missing event name or event id" });
        }
        if (event === MISMATCH || eventId === MISMATCH) {
          return jsonResponse(400, {
            error: "Event headers do not match the signed body",
          });
        }
        await ctx.runMutation(this.component.lib.handleWebhookEvent, {
          options: await this.runtimeOptions(),
          eventId,
          event,
          payload,
          receivedAt: Date.now(),
        });
        return new Response(null, { status: 200 });
      }),
    });
  }

  /**
   * Starts an OAuth connect flow. In multi-tenant mode this creates the user's
   * Zernio profile on first call. `state` is opaque: never parse it.
   */
  async connectAccountUrl(
    ctx: ActionCtx,
    args: { platform: string; redirectUrl?: string; userId?: string },
  ): Promise<{ authUrl: string; state: string; profileId: string }> {
    const tenant = await this.tenancy(ctx, args.userId);
    const options = await this.runtimeOptions();
    const result = await this.call(() =>
      ctx.runAction(this.component.lib.connectUrl, {
        options,
        apiKey: this.apiKey(),
        platform: args.platform,
        ...(args.redirectUrl !== undefined
          ? { redirectUrl: args.redirectUrl }
          : {}),
        ...(tenant.profileName !== undefined
          ? { profileName: tenant.profileName }
          : {}),
        ...tenantArgs(tenant),
      }),
    );
    return {
      authUrl: result.authUrl,
      state: result.state,
      profileId: result.zernioProfileId,
    };
  }

  /**
   * Pulls the profile's accounts from Zernio into the component's table.
   * Accounts that disappeared are marked inactive, never deleted. Safe as the
   * first call: it creates the user's profile when there is none yet.
   */
  async syncAccounts(
    ctx: ActionCtx,
    args?: { userId?: string },
  ): Promise<ZernioAccount[]> {
    const tenant = await this.tenancy(ctx, args?.userId);
    const options = await this.runtimeOptions();
    return await this.call(() =>
      ctx.runAction(this.component.lib.syncAccounts, {
        options,
        apiKey: this.apiKey(),
        ...(tenant.profileName !== undefined
          ? { profileName: tenant.profileName }
          : {}),
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * Reads the component's account table, so this is a real reactive query and
   * makes no HTTP call. Returns inactive accounts too; filter on `isActive`.
   */
  async listAccounts(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    args?: { userId?: string; platform?: string },
  ): Promise<ZernioAccount[]> {
    const tenant = await this.tenancy(ctx, args?.userId);
    return await this.call(() =>
      ctx.runQuery(this.component.lib.listAccounts, {
        ...(args?.platform !== undefined ? { platform: args.platform } : {}),
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * Enqueues a post. Safe to retry: the same `idempotencyKey` (or the same
   * content, which derives one) returns the existing post with
   * `duplicate: true` instead of creating a second one.
   *
   * With the default `testMode: true` the post is created as a Zernio DRAFT and
   * never reaches an audience. Throws when an `accountId` is unknown locally:
   * call `syncAccounts` first.
   */
  async schedulePost(
    ctx: MutationCtx | ActionCtx,
    args: {
      accountIds: string[];
      content: string;
      scheduledFor?: number;
      title?: string;
      mediaUrls?: string[];
      timezone?: string;
      idempotencyKey?: string;
      userId?: string;
    },
  ): Promise<{
    postId: string;
    status: ZernioPostStatus;
    duplicate: boolean;
  }> {
    const tenant = await this.tenancy(ctx, args.userId);
    const options = await this.runtimeOptions();
    return await this.call(() =>
      ctx.runMutation(this.component.lib.schedulePost, {
        options,
        apiKey: this.apiKey(),
        accountIds: args.accountIds,
        content: args.content,
        ...(args.scheduledFor !== undefined
          ? { scheduledFor: args.scheduledFor }
          : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.mediaUrls !== undefined ? { mediaUrls: args.mediaUrls } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.idempotencyKey !== undefined
          ? { idempotencyKey: args.idempotencyKey }
          : {}),
        ...(this.options.maxParallelism !== undefined
          ? { maxParallelism: this.options.maxParallelism }
          : {}),
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * Returns `null` for a post id that is unknown, malformed, or owned by
   * another tenant, rather than throwing.
   */
  async status(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<ZernioPostStatusSummary | null> {
    const tenant = await this.tenancy(ctx, args?.userId);
    return await this.call(() =>
      ctx.runQuery(this.component.lib.getPostStatus, {
        postId,
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * Returns `null` for a post id that is unknown, malformed, or owned by
   * another tenant, rather than throwing.
   */
  async getPost(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<ZernioPost | null> {
    const tenant = await this.tenancy(ctx, args?.userId);
    return await this.call(() =>
      ctx.runQuery(this.component.lib.getPost, {
        postId,
        ...tenantArgs(tenant),
      }),
    );
  }

  /** Newest first. Returns `[]` when the caller has no Zernio profile yet. */
  async listPosts(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    args?: { userId?: string; status?: ZernioPostStatus; limit?: number },
  ): Promise<ZernioPost[]> {
    const tenant = await this.tenancy(ctx, args?.userId);
    return await this.call(() =>
      ctx.runQuery(this.component.lib.listPosts, {
        ...(args?.status !== undefined ? { status: args.status } : {}),
        ...(args?.limit !== undefined ? { limit: args.limit } : {}),
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * Cancels a post that has not published yet: the queued job when it is still
   * local, otherwise `DELETE /v1/posts/{id}`. Throws for a published or partial
   * post, and returns `cancelled: false` for one already cancelled. Cancelling
   * a post whose create is in flight cannot recall that call, so the component
   * records the Zernio post id and deletes that post as soon as the create
   * returns. Throws for a post id that is unknown, malformed, or owned by
   * another tenant.
   */
  async cancelPost(
    ctx: ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<{
    postId: string;
    status: ZernioPostStatus;
    cancelled: boolean;
  }> {
    const tenant = await this.tenancy(ctx, args?.userId);
    const options = await this.runtimeOptions();
    return await this.call(() =>
      ctx.runAction(this.component.lib.cancelPost, {
        options,
        apiKey: this.apiKey(),
        postId,
        ...tenantArgs(tenant),
      }),
    );
  }

  /**
   * The raw escape hatch for the rest of the Zernio API. A non-2xx does NOT
   * throw: read `ok` and `data` (Zernio's error envelope). `testMode` does not
   * rewrite anything here, so a publish through `request()` publishes for real.
   */
  async request<T = unknown>(
    ctx: ActionCtx,
    args: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      userId?: string;
    },
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const options = await this.runtimeOptions();
    // Best effort: a call from a cron with neither auth nor a configured
    // profile still works, it just shares the fallback rate-limit bucket.
    const tenant = await this.optionalTenancy(ctx, args.userId);
    const result = await this.call(() =>
      ctx.runAction(this.component.lib.request, {
        options,
        apiKey: this.apiKey(),
        method: args.method,
        path: args.path,
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...tenantArgs(tenant),
      }),
    );
    return {
      status: result.status,
      ok: result.ok,
      data: result.data as T,
    };
  }

  /**
   * Functions to re-export from the app for direct frontend use. Every one of
   * them resolves the caller through `options.getUserInfo`, which is therefore
   * mandatory: these are public and reachable from a browser. The resolved user
   * scopes the call, so a post id belonging to another tenant reads as unknown.
   */
  api() {
    const getUserInfo = this.options.getUserInfo;
    if (getUserInfo === undefined) {
      throw new ZernioError(
        "api() requires options.getUserInfo: the exposed functions are public and must be identity-gated.",
      );
    }
    return {
      listAccounts: queryGeneric({
        args: { platform: v.optional(v.string()) },
        handler: async (ctx, args): Promise<ZernioAccount[]> => {
          const { userId } = await getUserInfo(ctx);
          return await this.listAccounts(ctx, { ...args, userId });
        },
      }),
      listPosts: queryGeneric({
        args: {
          status: v.optional(vPostStatusUnion),
          limit: v.optional(v.number()),
        },
        handler: async (ctx, args): Promise<ZernioPost[]> => {
          const { userId } = await getUserInfo(ctx);
          return await this.listPosts(ctx, { ...args, userId });
        },
      }),
      getPost: queryGeneric({
        args: { postId: v.string() },
        handler: async (ctx, args): Promise<ZernioPost | null> => {
          const { userId } = await getUserInfo(ctx);
          return await this.getPost(ctx, args.postId, { userId });
        },
      }),
      status: queryGeneric({
        args: { postId: v.string() },
        handler: async (ctx, args): Promise<ZernioPostStatusSummary | null> => {
          const { userId } = await getUserInfo(ctx);
          return await this.status(ctx, args.postId, { userId });
        },
      }),
      schedulePost: mutationGeneric({
        args: {
          accountIds: v.array(v.string()),
          content: v.string(),
          scheduledFor: v.optional(v.number()),
          title: v.optional(v.string()),
          mediaUrls: v.optional(v.array(v.string())),
          timezone: v.optional(v.string()),
          idempotencyKey: v.optional(v.string()),
        },
        handler: async (ctx, args) => {
          const { userId } = await getUserInfo(ctx);
          return await this.schedulePost(ctx, { ...args, userId });
        },
      }),
      cancelPost: actionGeneric({
        args: { postId: v.string() },
        handler: async (ctx, args) => {
          const { userId } = await getUserInfo(ctx);
          return await this.cancelPost(ctx, args.postId, { userId });
        },
      }),
      connectAccountUrl: actionGeneric({
        args: {
          platform: v.string(),
          redirectUrl: v.optional(v.string()),
        },
        handler: async (ctx, args) => {
          const { userId } = await getUserInfo(ctx);
          return await this.connectAccountUrl(ctx, { ...args, userId });
        },
      }),
      syncAccounts: actionGeneric({
        args: {},
        handler: async (ctx): Promise<ZernioAccount[]> => {
          const { userId } = await getUserInfo(ctx);
          return await this.syncAccounts(ctx, { userId });
        },
      }),
    };
  }

  private apiKey(): string {
    const apiKey = this.options.apiKey ?? process.env.ZERNIO_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ZernioError(
        "Missing Zernio API key: set options.apiKey or ZERNIO_API_KEY.",
      );
    }
    return apiKey;
  }

  private async runtimeOptions(): Promise<RuntimeOptions> {
    const onPostEvent =
      this.options.onPostEvent !== undefined
        ? await createFunctionHandle(this.options.onPostEvent)
        : undefined;
    const onAccountEvent =
      this.options.onAccountEvent !== undefined
        ? await createFunctionHandle(this.options.onAccountEvent)
        : undefined;
    return {
      baseUrl: (
        this.options.baseUrl ??
        process.env.ZERNIO_BASE_URL ??
        DEFAULT_BASE_URL
      ).replace(/\/+$/, ""),
      testMode: this.options.testMode ?? true,
      ...(onPostEvent !== undefined ? { onPostEvent } : {}),
      ...(onAccountEvent !== undefined ? { onAccountEvent } : {}),
    };
  }

  private async optionalTenancy(
    ctx: { auth?: Auth },
    userId?: string,
  ): Promise<Tenant> {
    try {
      return await this.tenancy(ctx, userId);
    } catch {
      return {};
    }
  }

  private async tenancy(
    ctx: { auth?: Auth },
    userId?: string,
  ): Promise<Tenant> {
    // An explicit userId wins in both modes, so a single-tenant app can still
    // make one call on behalf of a user.
    if (userId !== undefined) {
      return { userId };
    }
    const getUserInfo = this.options.getUserInfo;
    if (getUserInfo !== undefined) {
      if (ctx.auth === undefined) {
        throw new ZernioError("getUserInfo requires a ctx with auth");
      }
      const info = await getUserInfo({ auth: ctx.auth });
      return {
        userId: info.userId,
        ...(info.email !== undefined ? { profileName: info.email } : {}),
      };
    }
    const profileId = this.options.profileId ?? process.env.ZERNIO_PROFILE_ID;
    if (profileId === undefined || profileId.length === 0) {
      throw new ZernioError(
        "Missing profileId: set options.profileId or ZERNIO_PROFILE_ID.",
      );
    }
    return { zernioProfileId: profileId };
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toZernioError(error);
    }
  }
}

const vPostStatusUnion = v.union(
  v.literal("pending"),
  v.literal("submitting"),
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("published"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

// Convenient types for `ctx` args, that only include the bare minimum.

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery"> & {
  auth?: Auth;
};
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
> & { auth?: Auth };
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
> & { auth?: Auth };
