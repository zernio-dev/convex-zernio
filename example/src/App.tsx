import "./App.css";
import { useAction, useMutation, useQuery } from "convex/react";
import { useZernioPost } from "@zernio/convex/react";
import { useMemo, useState } from "react";
import { api } from "../convex/_generated/api";

const PLATFORMS = [
  "twitter",
  "instagram",
  "linkedin",
  "facebook",
  "threads",
  "tiktok",
  "youtube",
];

const STEP_LABELS: Record<string, string> = {
  pending: "Queued locally",
  submitting: "Submitting to Zernio",
  scheduled: "Scheduled at Zernio",
  draft: "Draft (test mode)",
  published: "Published",
  partial: "Partially published",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Where each state comes from, which is the part a developer is evaluating.
const STEP_SOURCES: Record<string, string> = {
  pending: "component mutation",
  submitting: "workpool job",
  scheduled: "POST /v1/posts",
  draft: "POST /v1/posts",
  published: "webhook",
  partial: "webhook",
  failed: "webhook",
  cancelled: "webhook",
};

const TERMINAL = ["draft", "published", "partial", "failed", "cancelled"];

function pipelineFor(post: {
  status: string;
  testMode: boolean;
  scheduledFor: number | null;
}): { steps: string[]; activeIndex: number } {
  const settledElsewhere =
    post.status === "failed" ||
    post.status === "partial" ||
    post.status === "cancelled";
  const last = settledElsewhere
    ? post.status
    : post.testMode
      ? "draft"
      : "published";
  const waiting = !post.testMode && post.scheduledFor !== null;
  const steps = [
    "pending",
    "submitting",
    ...(waiting ? ["scheduled"] : []),
    last,
  ];
  const found = steps.indexOf(post.status);
  return { steps, activeIndex: found === -1 ? steps.length - 1 : found };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{status}</span>;
}

/**
 * The whole point of the component: this panel never polls. Every Zernio
 * webhook lands in the component's table inside one transaction, which
 * invalidates `api.example.status` and repaints these steps.
 */
function LivePost({ postId }: { postId: string }) {
  const { post, isLoading, isSettled, errorMessage } = useZernioPost(
    api.example.status,
    postId,
  );
  const cancelPost = useAction(api.example.cancelPost);

  if (isLoading) {
    return <p className="muted">Loading post…</p>;
  }
  if (post === null) {
    return <p className="muted">That post is not in the component table.</p>;
  }

  const { steps, activeIndex } = pipelineFor(post);

  return (
    <div>
      <div className="live-head">
        <span className={`pulse ${isSettled ? "pulse-off" : ""}`} />
        <strong>{isSettled ? "Settled" : "Waiting on Zernio"}</strong>
        <span className="muted mono">
          {post.zernioPostId ?? "no Zernio id yet"}
        </span>
        {!isSettled && (
          <button className="ghost" onClick={() => void cancelPost({ postId })}>
            Cancel
          </button>
        )}
      </div>

      <ol className="pipeline">
        {steps.map((step, index) => (
          <li
            key={step}
            className={
              index < activeIndex
                ? "step done"
                : index === activeIndex
                  ? `step active step-${step}`
                  : "step"
            }
          >
            <span className="dot" />
            <span className="step-label">{STEP_LABELS[step] ?? step}</span>
            <span className="step-source">{STEP_SOURCES[step] ?? ""}</span>
          </li>
        ))}
      </ol>

      {errorMessage !== null && <p className="error">{errorMessage}</p>}

      <table className="targets">
        <tbody>
          {post.platforms.map((target) => (
            <tr key={`${target.platform}:${target.accountId}`}>
              <td className="mono">{target.platform}</td>
              <td>
                <StatusChip status={target.status} />
              </td>
              <td>
                {target.publishedUrl !== undefined ? (
                  <a
                    href={target.publishedUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    view
                  </a>
                ) : (
                  <span className="muted">
                    {target.errorMessage ?? "waiting"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhookStream() {
  const postEvents = useQuery(api.example.postEvents, { limit: 15 });
  const accountEvents = useQuery(api.example.accountEvents, { limit: 15 });

  const rows = useMemo(() => {
    const merged = [
      ...(postEvents ?? []).map((row) => ({
        id: row._id,
        at: row.receivedAt,
        event: row.event,
        detail: row.platform ?? row.status,
      })),
      ...(accountEvents ?? []).map((row) => ({
        id: row._id,
        at: row.receivedAt,
        event: row.event,
        detail: `${row.platform} ${row.username}`,
      })),
    ];
    return merged.sort((a, b) => b.at - a.at).slice(0, 15);
  }, [postEvents, accountEvents]);

  if (rows.length === 0) {
    return (
      <p className="muted">
        No webhooks yet. Point a Zernio subscription at{" "}
        <code>&lt;deployment&gt;.convex.site/zernio/webhook</code> and rows will
        stream in here.
      </p>
    );
  }
  return (
    <ul className="stream">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="mono time">{clock(row.at)}</span>
          <span className="mono event">{row.event}</span>
          <span className="muted">{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function App() {
  const accounts = useQuery(api.example.listAccounts, {});
  const posts = useQuery(api.example.listPosts, { limit: 20 });
  const schedulePost = useMutation(api.example.schedulePost);
  const syncAccounts = useAction(api.example.syncAccounts);
  const connectAccountUrl = useAction(api.example.connectAccountUrl);

  const [platform, setPlatform] = useState(PLATFORMS[0]);
  const [content, setContent] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [whenMode, setWhenMode] = useState<"now" | "at">("now");
  const [whenLocal, setWhenLocal] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [focusedPostId, setFocusedPostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const active = (accounts ?? []).filter((account) => account.isActive);
  const chosen =
    selected.length > 0
      ? selected
      : active.map((account) => account.zernioAccountId);
  const focused = focusedPostId ?? posts?.[0]?._id ?? null;

  const toggle = (accountId: string) => {
    const base = selected.length > 0 ? selected : chosen;
    setSelected(
      base.includes(accountId)
        ? base.filter((id) => id !== accountId)
        : [...base, accountId],
    );
  };

  const handleSchedule = async () => {
    setNotice(null);
    if (content.trim().length === 0 || chosen.length === 0) {
      setNotice("Pick at least one account and write something.");
      return;
    }
    try {
      const result = await schedulePost({
        accountIds: chosen,
        content,
        ...(whenMode === "at"
          ? { scheduledFor: new Date(whenLocal).getTime() }
          : {}),
        ...(mediaUrl.trim().length > 0 ? { mediaUrls: [mediaUrl.trim()] } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setFocusedPostId(result.postId);
      setContent("");
      setMediaUrl("");
      if (result.duplicate) {
        setNotice("Same idempotency key, so the existing post came back.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const handleConnect = async () => {
    setNotice(null);
    try {
      const { authUrl } = await connectAccountUrl({ platform });
      window.location.href = authUrl;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main>
      <header>
        <h1>Zernio for Convex</h1>
        <p className="muted">
          Schedule to social platforms, then watch the component's tables track
          the post while Zernio works.
        </p>
        <p className="banner">
          <strong>Test mode is on.</strong> Every post is created as a Zernio
          draft and never reaches an audience. Set <code>testMode: false</code>{" "}
          in <code>example/convex/example.ts</code> to publish for real.
        </p>
      </header>

      {notice !== null && <p className="notice">{notice}</p>}

      <div className="grid">
        <section className="card">
          <h2>Accounts</h2>
          <div className="row">
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
            >
              {PLATFORMS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button onClick={() => void handleConnect()}>Connect</button>
            <button className="ghost" onClick={() => void syncAccounts({})}>
              Sync
            </button>
          </div>
          {accounts === undefined ? (
            <p className="muted">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="muted">
              Nothing connected yet. Connect an account, or hit Sync if you
              already connected one in the Zernio dashboard.
            </p>
          ) : (
            <ul className="accounts">
              {accounts.map((account) => (
                <li key={account._id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!account.isActive}
                      checked={chosen.includes(account.zernioAccountId)}
                      onChange={() => toggle(account.zernioAccountId)}
                    />
                    <span className="mono">{account.platform}</span>
                    <span>{account.username}</span>
                    {!account.isActive && (
                      <span className="muted">disconnected</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}

          <h2>Compose</h2>
          <textarea
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="What are you posting?"
          />
          <input
            value={mediaUrl}
            onChange={(event) => setMediaUrl(event.target.value)}
            placeholder="Media URL (optional)"
          />
          <div className="row">
            <label className="inline">
              <input
                type="radio"
                checked={whenMode === "now"}
                onChange={() => setWhenMode("now")}
              />
              Publish now
            </label>
            <label className="inline">
              <input
                type="radio"
                checked={whenMode === "at"}
                onChange={() => setWhenMode("at")}
              />
              Schedule for
            </label>
            <input
              type="datetime-local"
              value={whenLocal}
              disabled={whenMode !== "at"}
              onChange={(event) => setWhenLocal(event.target.value)}
            />
          </div>
          <button className="primary" onClick={() => void handleSchedule()}>
            Schedule post
          </button>
        </section>

        <section className="card live">
          <h2>
            Live status <span className="tag">useQuery, no polling</span>
          </h2>
          {focused === null ? (
            <p className="muted">Schedule a post to watch it move.</p>
          ) : (
            <LivePost postId={focused} />
          )}

          <h2>Webhook stream</h2>
          <WebhookStream />
        </section>
      </div>

      <section className="card">
        <h2>Posts</h2>
        {posts === undefined ? (
          <p className="muted">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="muted">No posts yet.</p>
        ) : (
          <ul className="posts">
            {posts.map((post) => (
              <li
                key={post._id}
                className={post._id === focused ? "focused" : ""}
                onClick={() => setFocusedPostId(post._id)}
              >
                <StatusChip status={post.status} />
                <span className="excerpt">{post.content}</span>
                <span className="muted mono">
                  {post.scheduledFor !== undefined
                    ? new Date(post.scheduledFor).toLocaleString()
                    : "now"}
                </span>
                {!TERMINAL.includes(post.status) && (
                  <span className="pulse small" />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
