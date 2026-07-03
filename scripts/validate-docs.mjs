#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, "docs");
const publicTextFiles = [
  "README.md",
  "SECURITY.md",
  "apps/hermes-async-bridge/README.md",
];

function walk(dir, predicate = () => true) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const htmlFiles = walk(docsRoot, (file) => file.endsWith(".html"));
const publicFiles = [
  ...htmlFiles,
  path.join(docsRoot, "docs/search-index.js"),
  ...publicTextFiles.map((file) => path.join(root, file)).filter(existsSync),
];

const failures = [];
function fail(message) {
  failures.push(message);
}
function rel(file) {
  return path.relative(root, file);
}
function read(file) {
  return readFileSync(file, "utf8");
}
function plainText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
function stripCodeSpans(text) {
  return text.replace(/<code[\s\S]*?<\/code>/gi, " ")
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ");
}

const expectedPages = [
  "docs/docs/safety/index.html",
  "docs/docs/operations/index.html",
  "docs/docs/walkthrough/index.html",
  "docs/docs/install/index.html",
  "docs/docs/bridge/index.html",
  "docs/docs/clients/index.html",
  "docs/docs/first-dispatch/index.html",
];
for (const page of expectedPages) {
  if (!existsSync(path.join(root, page))) fail(`Missing required docs page: ${page}`);
}

// Link and asset references inside published static docs.
for (const file of htmlFiles) {
  const html = read(file);
  const htmlWithoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const refs = [...htmlWithoutScripts.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|#|javascript:)/.test(ref)) continue;
    const [withoutHash] = ref.split("#");
    if (!withoutHash || withoutHash.startsWith("data:")) continue;
    const target = path.resolve(path.dirname(file), withoutHash);
    if (!existsSync(target)) fail(`${rel(file)} references missing ${ref}`);
  }
  for (const match of htmlWithoutScripts.matchAll(/href="([^"]*#[^"]+)"/g)) {
    const href = match[1];
    if (href.startsWith("http")) continue;
    const [refPath, id] = href.split("#");
    const targetFile = refPath ? path.resolve(path.dirname(file), refPath, refPath.endsWith("/") ? "index.html" : "") : file;
    const checkFile = existsSync(targetFile) && statSync(targetFile).isDirectory() ? path.join(targetFile, "index.html") : targetFile;
    if (id && existsSync(checkFile)) {
      const targetHtml = read(checkFile);
      if (!new RegExp(`id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(targetHtml)) {
        fail(`${rel(file)} links to missing anchor ${href}`);
      }
    }
  }
}

// Public-safe examples: placeholders are allowed; concrete private addresses and token samples are not.
const unsafePatterns = [
  { re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: "private 10/8 IP" },
  { re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, label: "private 192.168/16 IP" },
  { re: /\b172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b/, label: "private 172.16/12 IP" },
  { re: /\b100\.(?!x\.x\.x\b)\d{1,3}\.\d{1,3}\.\d{1,3}\b/, label: "concrete tailnet IP" },
  { re: /Authorization:\s*Bearer\s+(?!\$\{HERMES_MCP_TOKEN\}|<bridge-bearer-token>|<redacted>|TOKEN_PLACEHOLDER)\S+/i, label: "raw bearer token example" },
  { re: /HERM\.\.\.KEN|<to\.\.\.de>|<to\.\.\.ode>|Bearer \*\*\*/, label: "malformed or redacted placeholder snippet" },
];
for (const file of publicFiles) {
  const text = read(file);
  for (const { re, label } of unsafePatterns) {
    if (re.test(text)) fail(`${rel(file)} contains ${label}`);
  }
}

const safetyPage = path.join(root, "docs/docs/safety/index.html");
if (existsSync(safetyPage)) {
  const text = plainText(read(safetyPage)).toLowerCase();
  const required = [
    "operator-grade access",
    "localhost, vpn, tailnet, or controlled lan",
    "blind public interface exposure is unsafe",
    "store bearer tokens",
    "rotate",
    "unauthenticated mcp initialize must fail",
    "authenticated mcp initialize must succeed",
    "health endpoint is liveness only",
    "private ips, hostnames, secrets, channel ids",
  ];
  for (const phrase of required) if (!text.includes(phrase)) fail(`safety page missing required phrase: ${phrase}`);
}

const combinedPublicText = publicFiles.map((file) => plainText(read(file))).join("\n").toLowerCase();
for (const phrase of [
  "private network",
  "bearer auth",
  "unauthenticated mcp initialize must fail",
  "authenticated mcp initialize must succeed",
  "health endpoint is liveness only",
  "result prose is a claim",
  "transcript evidence",
  "cost reporting",
  "unknown cost is not free",
]) {
  if (!combinedPublicText.includes(phrase)) fail(`published docs missing safety assertion: ${phrase}`);
}

for (const file of htmlFiles) {
  const html = read(file);
  if (file.includes(`${path.sep}docs${path.sep}docs${path.sep}`)) {
    if (/<div class="search"/.test(html)) fail(`${rel(file)} uses non-semantic div search control`);
    if (!/<button class="search"[^>]+aria-label="Search documentation"/.test(html)) fail(`${rel(file)} missing accessible search button`);
    if (!/<nav class="mobile-doc-nav"/.test(html)) fail(`${rel(file)} missing mobile docs navigation`);
    if (!/<input id="palInput"[^>]+aria-label="Search documentation"/.test(html)) fail(`${rel(file)} missing labelled search input`);
  }
  if (/<span class="copy"/.test(html)) fail(`${rel(file)} uses non-semantic span copy control`);
  if (/<div class="code">/.test(html) && !/<button class="copy"[^>]+aria-label="Copy code snippet"/.test(html)) {
    fail(`${rel(file)} missing accessible copy buttons`);
  }
  if (/\.code pre\s*\{[^}]*overflow-x:\s*auto/.test(html) === false && /<div class="code">/.test(html)) {
    fail(`${rel(file)} code blocks are not horizontally scrollable`);
  }
}

// Representative rendered/static page smoke coverage: title + expected navigation/index entries.
const searchIndex = path.join(root, "docs/docs/search-index.js");
if (existsSync(searchIndex)) {
  const index = read(searchIndex);
  for (const title of ["Operational safety", "Production operations", "End-to-end walkthrough"]) {
    if (!index.includes(title)) fail(`search index missing ${title}`);
  }
}

if (failures.length) {
  console.error(`Docs validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Docs validation passed: ${htmlFiles.length} HTML pages, ${publicFiles.length} public text files checked.`);
