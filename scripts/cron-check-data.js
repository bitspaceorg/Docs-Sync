#!/usr/bin/env node
/**
 * Global cron: for each Vercel project with DOCS_DEPLOYMENT_MANAGED, fetch DATA_URL,
 * compare timestamp to last run; if newer, trigger rebuild via Vercel API (create deployment with latest docs ref/sha).
 * Only DOCS_VERCEL_TOKEN required.
 * Persists last timestamps in .cache/cron-timestamps.json (cache in CI).
 */

import dotenv from "dotenv";
dotenv.config({ override: false });
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VERCEL_API = "https://api.vercel.com";

const TIMESTAMPS_FILE = process.env.CRON_TIMESTAMPS_FILE || path.join(ROOT, ".cache", "cron-timestamps.json");
const LAST_DEPLOYED_FILE = path.join(ROOT, ".cache", "cron-last-deployed.json");
const SKIP_REASONS_FILE = path.join(ROOT, ".cache", "cron-skip-reasons.json");
const TIMESTAMP_FIELD = process.env.CRON_TIMESTAMP_FIELD || "timestamp";

function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8");
  return parse(raw);
}

function loadTimestamps() {
  try {
    const data = fs.readFileSync(TIMESTAMPS_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveTimestamps(obj) {
  const dir = path.dirname(TIMESTAMPS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TIMESTAMPS_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function loadLastDeployed() {
  try {
    const data = fs.readFileSync(LAST_DEPLOYED_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveLastDeployed(obj) {
  const dir = path.dirname(LAST_DEPLOYED_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAST_DEPLOYED_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function saveSkipReasons(obj) {
  const dir = path.dirname(SKIP_REASONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SKIP_REASONS_FILE, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value < 1e10 ? value * 1000 : value;
  const n = parseFloat(value);
  if (!Number.isNaN(n)) return n < 1e10 ? n * 1000 : n;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

async function api(method, pathname, body, token, teamId) {
  const url = new URL(pathname, VERCEL_API);
  if (teamId) url.searchParams.set("teamId", teamId);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel API ${method} ${pathname}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function listVercelProjects(token, teamId) {
  const data = await api("GET", "/v10/projects?limit=100", null, token, teamId);
  return Array.isArray(data) ? data : data?.projects ?? [];
}

async function getProjectEnv(token, teamId, idOrName) {
  try {
    // Vercel does not return plaintext env values unless decrypt=true is provided.
    const data = await api("GET", `/v10/projects/${encodeURIComponent(idOrName)}/env?decrypt=true`, null, token, teamId);
    const list = Array.isArray(data) ? data : data?.env ?? [];
    return list;
  } catch (e) {
    if (e.message.includes("404")) return [];
    throw e;
  }
}

function envMap(envList) {
  const m = {};
  for (const e of envList || []) {
    if (e.key != null && e.value !== undefined) m[e.key] = e.value;
  }
  return m;
}

async function getLatestDocsRefSha(config) {
  const docsRepo = config.docsRepo;
  if (!docsRepo?.projectId) return null;
  const branch = process.env.DOCS_REF || docsRepo.productionBranch || "main";
  const token = process.env.CI_JOB_TOKEN || process.env.GITLAB_TOKEN || "";
  const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(docsRepo.projectId)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const commit = Array.isArray(data) ? data[0] : data;
  if (!commit?.id) return null;
  let sha = commit.id;
  if (sha.length < 40) {
    const commitUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(docsRepo.projectId)}/repository/commits/${encodeURIComponent(sha)}`;
    const r = await fetch(commitUrl, { headers });
    if (r.ok) {
      const c = await r.json();
      sha = c.id || sha;
    }
  }
  return { ref: branch, sha };
}

async function createDeployment(token, teamId, projectName, gitSource) {
  return await api(
    "POST",
    "/v13/deployments?skipAutoDetectionConfirmation=1",
    {
      name: projectName,
      project: projectName,
      target: "production",
      gitSource: {
        type: "gitlab",
        projectId: gitSource.projectId,
        ref: gitSource.ref,
        sha: gitSource.sha,
      },
    },
    token,
    teamId
  );
}

async function main() {
  const token = process.env.DOCS_VERCEL_API_TOKEN || process.env.DOCS_VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("Set DOCS_VERCEL_TOKEN (or VERCEL_TOKEN).");
    process.exit(1);
  }

  const config = loadConfig();
  const teamId = process.env.DOCS_VERCEL_TEAM_ID || process.env.VERCEL_TEAM_ID || config.vercel?.teamId || undefined;

  let gitSource = null;
  const docsRepo = config.docsRepo;
  if (docsRepo?.projectId) {
    gitSource = await getLatestDocsRefSha(config);
    if (gitSource) gitSource.projectId = docsRepo.projectId;
  }

  const projects = await listVercelProjects(token, teamId);
  console.log(`Found ${projects.length} Vercel project(s).`);
  const timestamps = loadTimestamps();
  const lastDeployed = loadLastDeployed();
  const skipReasons = {};

  let deployed = 0;
  let checked = 0;
  for (const proj of projects) {
    const envList = await getProjectEnv(token, teamId, proj.name);
    const env = envMap(envList);
    if (env.DOCS_DEPLOYMENT_MANAGED !== "1" && env.DOCS_DEPLOYMENT_MANAGED !== "true") {
      console.log(`  ${proj.name}: skipping (DOCS_DEPLOYMENT_MANAGED not set).`);
      continue;
    }
    checked++;
    console.log(`  ${proj.name}: checking...`);
    const dataUrl = env.DATA_URL;
    if (!dataUrl) {
      skipReasons[proj.name] = "DATA_URL not set; rebuild will not run.";
      continue;
    }

    let payload;
    try {
      const res = await fetch(dataUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      payload = await res.json();
    } catch (e) {
      skipReasons[proj.name] = `Failed to fetch DATA_URL: ${e.message}. Rebuild will not run.`;
      console.warn(`  ${proj.name}: fetch DATA_URL failed: ${e.message}`);
      continue;
    }

    const raw = payload[TIMESTAMP_FIELD];
    const currentMs = toMs(raw);
    if (currentMs == null) {
      skipReasons[proj.name] = `Timestamp missing or invalid in DATA_URL response (field "${TIMESTAMP_FIELD}"). Rebuild will not run.`;
      console.warn(`  ${proj.name}: missing or invalid "${TIMESTAMP_FIELD}"`);
      continue;
    }

    const key = proj.name;
    const lastMs = timestamps[key] != null ? Number(timestamps[key]) : null;
    const shouldDeploy = lastMs == null || currentMs > lastMs;

    if (shouldDeploy) {
      if (gitSource) {
        try {
          await createDeployment(token, teamId, proj.name, gitSource);
          lastDeployed[proj.name] = { at: new Date().toISOString(), domain: env.DOCS_DEPLOYMENT_FULL_DOMAIN || "" };
          console.log(`  ${proj.name}: deployed (timestamp changed).`);
          deployed++;
        } catch (e) {
          console.warn(`  ${proj.name}: deploy failed: ${e.message}`);
          continue;
        }
      } else {
        skipReasons[proj.name] = "No docsRepo in config; rebuild will not run.";
        console.warn(`  ${proj.name}: no docsRepo in config; skip deploy.`);
        timestamps[key] = currentMs;
        continue;
      }
    }

    timestamps[key] = currentMs;
  }

  saveTimestamps(timestamps);
  saveLastDeployed(lastDeployed);
  saveSkipReasons(skipReasons);
  console.log(`Done. Checked ${checked} project(s), deployed ${deployed} project(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
