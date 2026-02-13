#!/usr/bin/env node
/**
 * Reads .cache/cron-last-deployed.json and writes public/index.html with
 * "Last rebuilt: X ago" per project. Run from CI after cron:check-data (same pipeline).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT, ".cache", "cron-last-deployed.json");
const SKIP_REASONS_FILE = path.join(ROOT, ".cache", "cron-skip-reasons.json");
const OUT_FILE = path.join(ROOT, "public", "index.html");

function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8");
  return parse(raw);
}

function loadProjects(config) {
  const projectsDir = path.join(ROOT, "projects");
  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"));
  const domainMap = {};
  for (const file of files) {
    const id = path.basename(file, ".yaml");
    const raw = fs.readFileSync(path.join(projectsDir, file), "utf8");
    const data = parse(raw);
    const subdomain = data.project_subdomain ?? id;
    const fullDomain = `${subdomain}.${config.baseDomain}`;
    domainMap[id] = fullDomain;
  }
  return domainMap;
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day} day${day === 1 ? "" : "s"} ago`;
  if (hr > 0) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  if (min > 0) return `${min} min ago`;
  return "just now";
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const config = loadConfig();
const domainMap = loadProjects(config);

let lastDeployed = {};
try {
  lastDeployed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch {
  // no cache yet
}

let skipReasons = {};
try {
  skipReasons = JSON.parse(fs.readFileSync(SKIP_REASONS_FILE, "utf8"));
} catch {
  // none
}

// Merge all projects from yaml files, cache, and skip reasons
const allProjects = new Set([
  ...Object.keys(domainMap),
  ...Object.keys(lastDeployed),
  ...Object.keys(skipReasons),
]);

if (allProjects.size === 0) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Docs Sync</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Docs Sync</h1>
  <p>No rebuild triggered.</p>
</body>
</html>
`;
  const outDir = path.dirname(OUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, "utf8");
  console.log("Wrote public/index.html");
  process.exit(0);
}

// Build unified table rows
const rows = Array.from(allProjects)
  .map((name) => {
    const deployed = lastDeployed[name];
    const skipReason = skipReasons[name];
    // Get domain from deployed entry, or from projects/*.yaml, or empty
    let domain = "";
    if (deployed && typeof deployed === "object" && deployed != null && deployed.domain) {
      domain = deployed.domain;
    } else if (domainMap[name]) {
      domain = domainMap[name];
    }
    const deployedAt = typeof deployed === "string" ? deployed : deployed?.at;
    
    let status;
    if (skipReason) {
      // Handle both string and object format for skip reasons
      status = typeof skipReason === "string" ? skipReason : skipReason.reason || "";
    } else if (deployedAt) {
      status = `Last rebuilt: ${escape(ago(deployedAt))}`;
    } else {
      status = "Last rebuilt: never";
    }
    
    return `<tr><td><code>${escape(name)}</code></td><td>${domain ? `<a href="https://${escape(domain)}" target="_blank"><code>${escape(domain)}</code></a>` : "—"}</td><td>${escape(status)}</td></tr>`;
  })
  .join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Docs Sync</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f0f0f0; padding: 0.2em 0.4em; border-radius: 3px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; }
    th { font-weight: 600; }
    h1 { font-size: 1.25rem; }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Docs Sync</h1>
  <p>Per-project rebuild status.</p>
  <table>
    <thead><tr><th>Project</th><th>Domain</th><th>Status</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>
`;

const outDir = path.dirname(OUT_FILE);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT_FILE, html, "utf8");
console.log("Wrote public/index.html");
