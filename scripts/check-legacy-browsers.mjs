// Checks built client files for what an LG C1 (webOS 6, Chromium 79) cannot
// use: script syntax it cannot parse (one such script blanks the whole page),
// browser functions it lacks that `packages/client/src/legacy.ts` does not
// fill in, and CSS selectors that make it drop a whole rule.
// Usage: node scripts/check-legacy-browsers.mjs <dist dir>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

// Chunks that only a current browser is asked to run. PDF.js 6 needs one;
// the PDF reader is the only thing that loads it.
const CURRENT_BROWSER_ONLY = [/(^|\/)PdfPage-[\w-]+\.js$/, /pdf\.worker/];

// Functions newer than Chromium 79. A call that opens a `try` block (as in
// `try{return crypto.randomUUID()}`, or React's own view transitions) already
// copes with the function missing.
const APIS = [
  [/\bstructuredClone\(/g, "structuredClone (Chrome 98)"],
  [/\bcrypto\.randomUUID\(/g, "crypto.randomUUID (Chrome 92)"],
  [/\bObject\.hasOwn\(/g, "Object.hasOwn (Chrome 93)"],
  [/\.replaceAll\(/g, "String.replaceAll (Chrome 85)"],
  [/\.findLast(Index)?\(/g, "Array.findLast (Chrome 97)"],
  [/\bPromise\.(any|withResolvers)\(/g, "Promise.any/withResolvers"],
  [/\.(toSorted|toReversed|toSpliced)\(/g, "Array.toSorted (Chrome 110)"],
  [/\b(Object|Map)\.groupBy\(/g, "groupBy (Chrome 117)"],
  [/\bArray\.fromAsync\(/g, "Array.fromAsync (Chrome 121)"],
  [/\bnew WeakRef\(/g, "WeakRef (Chrome 84)"],
  [/\bnew Intl\.Segmenter\(/g, "Intl.Segmenter (Chrome 87)"],
  [/\bPromise\.try\(/g, "Promise.try (Chrome 128)"],
  [/\bURL\.(parse|canParse)\(/g, "URL.parse/canParse (Chrome 120)"],
  [/\.at\((-?\d|[A-Za-z_$])/g, "Array/String .at (Chrome 92)"],
  [/\.checkVisibility\(/g, "checkVisibility (Chrome 105)"],
  [/\bstartViewTransition\(/g, "startViewTransition (Chrome 111)"],
  [/\.showPopover\(/g, "popover (Chrome 114)"],
  [
    /\bnew (Compression|Decompression)Stream\(/g,
    "CompressionStream (Chrome 80)",
  ],
];

// Selectors Chromium 79 does not know. A rule naming one is dropped whole,
// including every other selector in its list.
const SELECTORS = [
  [/:is\(/, ":is() (Chrome 88)"],
  [/:where\(/, ":where() (Chrome 88)"],
  [/:has\(/, ":has() (Chrome 105)"],
  [/:focus-visible/, ":focus-visible (Chrome 86)"],
];

function cssProblems(source) {
  const found = new Set();
  // Selector preludes: the text before each `{` that is not an at-rule.
  for (const match of source.matchAll(/(?:^|[{};])\s*([^{};@]+)\{/g)) {
    const prelude = match[1].trim();
    const list = prelude.split(",");
    for (const [pattern, label] of SELECTORS) {
      if (!pattern.test(prelude)) continue;
      // `:focus-visible` alone in its rule costs only that rule, which the
      // `[data-focus-visible="fallback"]` copies stand in for.
      if (label.startsWith(":focus-visible") && list.length === 1) continue;
      found.add(`${label} in "${prelude.slice(0, 80)}"`);
    }
  }
  return [...found];
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(m?js|css)$/.test(name) ? [path] : [];
  });
}

function syntaxProblems(source) {
  const found = new Set();
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  for (const statement of ast.body)
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AwaitExpression"
    )
      found.add("top-level await (Chrome 89)");
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ChainExpression") found.add("?. (Chrome 80)");
    if (node.type === "LogicalExpression" && node.operator === "??")
      found.add("?? (Chrome 80)");
    if (
      node.type === "AssignmentExpression" &&
      ["??=", "||=", "&&="].includes(node.operator)
    )
      found.add("logical assignment (Chrome 85)");
    if (
      node.type === "MethodDefinition" &&
      node.key.type === "PrivateIdentifier"
    )
      found.add("private methods (Chrome 84)");
    if (node.type === "StaticBlock") found.add("static blocks (Chrome 94)");
    if (
      node.type === "BinaryExpression" &&
      node.left.type === "PrivateIdentifier"
    )
      found.add("#field in (Chrome 91)");
    if (node.type === "Literal" && node.regex && /[dv]/.test(node.regex.flags))
      found.add("regular expression flag d or v");
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === "string") visit(value);
    }
  };
  visit(ast);
  return [...found];
}

export function checkLegacyBrowsers(dirs) {
  const problems = [];
  for (const dir of dirs)
    for (const path of files(dir)) {
      const name = relative(dir, path);
      if (CURRENT_BROWSER_ONLY.some((pattern) => pattern.test(name))) continue;
      const source = readFileSync(path, "utf8");
      if (name.endsWith(".css")) {
        for (const problem of cssProblems(source))
          problems.push(`${name}: ${problem}`);
        continue;
      }
      for (const problem of syntaxProblems(source))
        problems.push(`${name}: ${problem}`);
      for (const [pattern, label] of APIS) {
        const unguarded = [...source.matchAll(pattern)].filter(
          (match) =>
            !/try\{[^{}]{0,24}$/.test(
              source.slice(Math.max(0, match.index - 32), match.index),
            ),
        );
        if (unguarded.length) problems.push(`${name}: ${label}`);
      }
    }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error("usage: check-legacy-browsers.mjs <dist dir>...");
    process.exit(2);
  }
  const problems = checkLegacyBrowsers(dirs);
  for (const problem of problems) console.error(problem);
  console.log(
    problems.length
      ? `${problems.length} problem(s) for Chromium 79`
      : "Chromium 79 can run every checked script",
  );
  process.exit(problems.length ? 1 : 0);
}
