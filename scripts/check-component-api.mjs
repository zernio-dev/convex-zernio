/**
 * Guards `src/component/_generated/component.ts` against drift.
 *
 * `convex codegen` needs a linked deployment, so CI cannot regenerate that file.
 * This compares the ComponentApi declarations against the real `args` validators
 * and fails when a function or an argument exists on one side only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = "src/component";
const GENERATED = join(COMPONENT_DIR, "_generated/component.ts");

function braceSlice(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(openIndex, i + 1);
  }
  return "";
}

function topLevelKeys(block) {
  const keys = new Set();
  for (const match of block.matchAll(/(\w+)\??\s*:/g)) {
    const before = block.slice(0, match.index);
    const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    if (depth === 1) keys.add(match[1]);
  }
  return keys;
}

const actual = new Map();
for (const file of readdirSync(COMPONENT_DIR)) {
  if (!file.endsWith(".ts") || file.includes(".test.")) continue;
  const source = readFileSync(join(COMPONENT_DIR, file), "utf8");
  const declaration = /export const (\w+) = (?:internal)?(?:query|mutation|action)\(\{/g;
  for (const match of source.matchAll(declaration)) {
    const body = braceSlice(source, match.index + match[0].length - 1);
    const args = /\bargs:\s*\{/.exec(body);
    actual.set(match[1], args ? topLevelKeys(braceSlice(body, args.index + args[0].length - 1)) : new Set());
  }
}

const generated = readFileSync(GENERATED, "utf8");
const declared = new Map();
const reference = /(\w+): FunctionReference<\s*"(?:query|mutation|action)",\s*"\w+",\s*/g;
for (const match of generated.matchAll(reference)) {
  const rest = generated.slice(match.index + match[0].length);
  declared.set(
    match[1],
    rest.trimStart().startsWith("{") ? topLevelKeys(braceSlice(rest, rest.indexOf("{"))) : new Set(),
  );
}

const problems = [];
for (const [name, args] of actual) {
  if (!declared.has(name)) {
    problems.push(`${name}: exported by the component but missing from ComponentApi`);
    continue;
  }
  const generatedArgs = declared.get(name);
  const missing = [...args].filter((a) => !generatedArgs.has(a));
  const extra = [...generatedArgs].filter((a) => !args.has(a));
  if (missing.length) problems.push(`${name}: args missing from ComponentApi: ${missing.join(", ")}`);
  if (extra.length) problems.push(`${name}: args in ComponentApi that no longer exist: ${extra.join(", ")}`);
}
for (const name of declared.keys()) {
  if (!actual.has(name)) problems.push(`${name}: declared in ComponentApi but not exported by the component`);
}

if (problems.length) {
  console.error(`${GENERATED} is out of date:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\nRegenerate it with \`npx convex dev\` on a machine with a linked deployment.`);
  process.exit(1);
}

console.log(`ComponentApi matches all ${actual.size} component functions.`);
