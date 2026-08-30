/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

type PostStatus =
  | "pending"
  | "submitting"
  | "draft"
  | "scheduled"
  | "published"
  | "partial"
  | "failed"
  | "cancelled";

type PlatformTarget = {
  accountId: string;
  errorMessage?: string;
  platform: string;
  platformPostId?: string;
  publishedAt?: number;
  publishedUrl?: string;
  status:
    | "pending"
    | "processing"
    | "uploading"
    | "published"
    | "failed"
    | "cancelled";
};

type RuntimeOptions = {
  baseUrl: string;
  onAccountEvent?: string;
  onPostEvent?: string;
  testMode: boolean;
};

type PostDoc = {
  _creationTime: number;
  _id: string;
  accountIds: Array<string>;
  content: string;
  errorMessage?: string;
  finalizedAt?: number;
  idempotencyKey: string;
  lastEventAt?: number;
  mediaUrls?: Array<string>;
  platforms: Array<PlatformTarget>;
  scheduledFor?: number;
  status: PostStatus;
  submitAttempts?: number;
  submittedAt?: number;
  testMode: boolean;
  timezone?: string;
  title?: string;
  workId?: string;
  zernioPostId?: string;
  zernioProfileId: string;
};

type AccountDoc = {
  _creationTime: number;
  _id: string;
  avatarUrl?: string;
  displayName?: string;
  isActive: boolean;
  lastEventAt?: number;
  platform: string;
  syncedAt: number;
  username: string;
  zernioAccountId: string;
  zernioProfileId: string;
};

type PostStatusSummary = {
  errorMessage: null | string;
  finalizedAt: null | number;
  platforms: Array<PlatformTarget>;
  postId: string;
  scheduledFor: null | number;
  status: PostStatus;
  submittedAt: null | number;
  testMode: boolean;
  zernioPostId: null | string;
};

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      cancelPost: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          options: RuntimeOptions;
          postId: string;
          userId?: string;
          zernioProfileId?: string;
        },
        { cancelled: boolean; postId: string; status: PostStatus },
        Name
      >;
      connectUrl: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          options: RuntimeOptions;
          platform: string;
          profileName?: string;
          redirectUrl?: string;
          userId?: string;
          zernioProfileId?: string;
        },
        { authUrl: string; state: string; zernioProfileId: string },
        Name
      >;
      getPost: FunctionReference<
        "query",
        "internal",
        { postId: string; userId?: string; zernioProfileId?: string },
        null | PostDoc,
        Name
      >;
      getPostStatus: FunctionReference<
        "query",
        "internal",
        { postId: string; userId?: string; zernioProfileId?: string },
        null | PostStatusSummary,
        Name
      >;
      handleWebhookEvent: FunctionReference<
        "mutation",
        "internal",
        {
          event: string;
          eventId: string;
          options?: RuntimeOptions;
          payload: any;
          receivedAt?: number;
        },
        {
          accountId: null | string;
          applied: boolean;
          deduped: boolean;
          postId: null | string;
        },
        Name
      >;
      listAccounts: FunctionReference<
        "query",
        "internal",
        { platform?: string; userId?: string; zernioProfileId?: string },
        Array<AccountDoc>,
        Name
      >;
      listPosts: FunctionReference<
        "query",
        "internal",
        {
          limit?: number;
          status?: PostStatus;
          userId?: string;
          zernioProfileId?: string;
        },
        Array<PostDoc>,
        Name
      >;
      request: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          body?: any;
          method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          options: RuntimeOptions;
          path: string;
          query?: Record<string, string>;
          userId?: string;
          zernioProfileId?: string;
        },
        { data: any; ok: boolean; status: number },
        Name
      >;
      schedulePost: FunctionReference<
        "mutation",
        "internal",
        {
          accountIds: Array<string>;
          apiKey: string;
          content: string;
          idempotencyKey?: string;
          maxParallelism?: number;
          mediaUrls?: Array<string>;
          options: RuntimeOptions;
          scheduledFor?: number;
          timezone?: string;
          title?: string;
          userId?: string;
          zernioProfileId?: string;
        },
        { duplicate: boolean; postId: string; status: PostStatus },
        Name
      >;
      syncAccounts: FunctionReference<
        "action",
        "internal",
        {
          apiKey: string;
          options: RuntimeOptions;
          profileName?: string;
          userId?: string;
          zernioProfileId?: string;
        },
        Array<AccountDoc>,
        Name
      >;
    };
  };
