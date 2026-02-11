#!/usr/bin/env node
/** Print export DOCS_REF=... DOCS_SHA=... for latest docs commit. Used by CI when DOCS_SHA not set. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadConfig() {
  return parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8"));
}

async function main() {
  const config = loadConfig();
  const docsRepo = config.docsRepo;
  if (!docsRepo?.projectId) {
    console.error("config.yaml must have docsRepo.projectId");
    process.exit(1);
  }
  const branch = process.env.DOCS_REF || docsRepo.productionBranch || "main";
  const projectId = docsRepo.projectId;
  const token = process.env.CI_JOB_TOKEN || process.env.GITLAB_TOKEN || "";
  const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GitLab API ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  const commit = Array.isArray(data) ? data[0] : data;
  if (!commit?.id) {
    console.error("No commit found for branch:", branch);
    process.exit(1);
  }
  // Safe for eval: single-quote and escape any single quotes in value
  const shEscape = (s) => `'${String(s).replace(/'/g, "'\"'\"'")}'`;
  console.log(`export DOCS_REF=${shEscape(branch)}`);
  console.log(`export DOCS_SHA=${shEscape(commit.id)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
