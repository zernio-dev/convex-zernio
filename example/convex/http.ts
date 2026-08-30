import { httpRouter } from "convex/server";
import { zernio } from "./example.js";

const http = httpRouter();

// Mounts POST /zernio/webhook. Point a Zernio webhook subscription at
// https://<your deployment>.convex.site/zernio/webhook and set the
// subscription's secret as ZERNIO_WEBHOOK_SECRET. The handler verifies the
// HMAC over the raw body before anything is written, and replies 200 to
// replays and to events the component does not consume.
zernio.registerRoutes(http);

export default http;
