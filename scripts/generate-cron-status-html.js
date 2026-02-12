#!/usr/bin/env node
/**
 * Reads .cache/cron-last-deployed.json and writes public/index.html with
 * "Last rebuilt: X ago" per project. Run from CI after cron:check-data (same pipeline).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT, ".cache", "cron-last-deployed.json");
const OUT_FILE = path.join(ROOT, "public", "index.html");

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

let data = {};
try {
  data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch {
  // no cache yet
}

const entries = Object.entries(data)
  .map(([name, v]) => ({
    name,
    at: typeof v === "string" ? v : v?.at,
    domain: typeof v === "object" && v != null ? v.domain : "",
  }))
  .filter((e) => e.at)
  .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

const rows =
  entries.length === 0
    ? "<p>No rebuilds recorded yet. Run a scheduled pipeline (cron:check-data) to see last rebuilt times.</p>"
    : `
  <table>
    <thead><tr><th>Project</th><th>Domain</th><th>Last rebuilt</th></tr></thead>
    <tbody>
      ${entries
        .map(
          (e) =>
            `<tr><td><code>${escape(e.name)}</code></td><td>${e.domain ? `<code>${escape(e.domain)}</code>` : "—"}</td><td>${escape(ago(e.at))}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Docs deployment – last rebuilt</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    code { background: #f0f0f0; padding: 0.2em 0.4em; border-radius: 3px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; }
    th { font-weight: 600; }
    h1 { font-size: 1.25rem; }
  </style>
</head>
<body>
  <h1>Docs Sync – last rebuilt</h1>
  <p>Per-project last rebuild time (from cron:check-data). Schedule: <code>* * * * *</code> on main.</p>
  ${rows}
</body>
</html>
`;

const outDir = path.dirname(OUT_FILE);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT_FILE, html, "utf8");
console.log("Wrote public/index.html");
