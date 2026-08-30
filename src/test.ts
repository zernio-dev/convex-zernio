/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/test";
import workpool from "@convex-dev/workpool/test";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 *
 * Post submission runs on a nested workpool and outbound calls are rate
 * limited, so both nested components are registered under the component's own
 * path (workpool in turn registers `${name}/postWorkpool/batchWorker`).
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "zernio",
) {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/postWorkpool`);
  rateLimiter.register(t, `${name}/rateLimiter`);
}
export default { register, schema, modules };
