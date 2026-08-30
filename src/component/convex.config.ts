import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";

const component = defineComponent("zernio");
component.use(workpool, { name: "postWorkpool" });
component.use(rateLimiter);

export default component;
