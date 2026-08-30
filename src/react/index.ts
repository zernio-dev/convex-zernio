"use client";

import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import type {
  ZernioPostStatus,
  ZernioPostStatusSummary,
} from "../client/index.js";

const SETTLED_STATUSES: readonly ZernioPostStatus[] = [
  "draft",
  "published",
  "partial",
  "failed",
  "cancelled",
];

/** The shape of `zernio.api().status`, re-exported from the app. */
export type ZernioPostStatusQuery = FunctionReference<
  "query",
  "public",
  { postId: string },
  ZernioPostStatusSummary | null
>;

export type ZernioPostView = {
  post: ZernioPostStatusSummary | null;
  isLoading: boolean;
  /** True once the post can no longer change without a new action. */
  isSettled: boolean;
  errorMessage: string | null;
};

/**
 * Subscribes to one post's status and derives the states a UI actually
 * branches on. Pass `undefined` for `postId` to skip the subscription.
 */
export function useZernioPost(
  statusQuery: ZernioPostStatusQuery,
  postId: string | undefined,
): ZernioPostView {
  const post = useQuery(
    statusQuery,
    postId === undefined ? "skip" : { postId },
  );
  return {
    post: post ?? null,
    isLoading: post === undefined,
    isSettled:
      post !== undefined &&
      post !== null &&
      SETTLED_STATUSES.includes(post.status),
    errorMessage: post?.errorMessage ?? null,
  };
}
