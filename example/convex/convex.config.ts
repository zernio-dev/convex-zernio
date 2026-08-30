import { defineApp } from "convex/server";
import zernio from "@zernio/convex/convex.config.js";

const app = defineApp();
app.use(zernio);

export default app;
