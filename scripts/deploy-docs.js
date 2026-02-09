#!/usr/bin/env node
/** Deploy docs repo (DOCS_REF, DOCS_SHA) to every Vercel project via gitSource API. Needs VERCEL_TOKEN, docsRepo.projectId. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const VERCEL_API = "https://api.vercel.com";

function loadConfig() {
  const raw = fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8");
  return parse(raw);
}

function loadProjectIds(config) {
  const projectsDir = path.join(ROOT, "projects");
  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"));
  return files.map((f) => path.basename(f, ".yaml"));
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
  if (!res.ok) {
    throw new Error(`Vercel API ${method} ${pathname}: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function createDeployment(token, teamId, projectName, gitSource) {
  return await api(
    "POST",
    "/v13/deployments",
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
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("Set VERCEL_TOKEN");
    process.exit(1);
  }

  const config = loadConfig();
  const docsRepo = config.docsRepo;
  if (!docsRepo?.projectId) {
    console.error("config.yaml must have docsRepo.projectId (GitLab numeric project ID)");
    process.exit(1);
  }

  const ref = process.env.DOCS_REF || docsRepo.productionBranch || "main";
  const sha = process.env.DOCS_SHA;
  if (!sha) {
    console.error("Set DOCS_SHA (commit SHA to deploy). When triggering from docs repo, pass CI_COMMIT_SHA.");
    process.exit(1);
  }

  const teamId = process.env.VERCEL_TEAM_ID || config.vercel?.teamId;
  const projectIds = loadProjectIds(config);

  console.log(`Deploying docs repo (ref=${ref}, sha=${sha.slice(0, 7)}) to ${projectIds.length} project(s)...`);

  const gitSource = { projectId: docsRepo.projectId, ref, sha };

  for (const id of projectIds) {
    console.log(`  Deploying ${id}...`);
    const d = await createDeployment(token, teamId, id, gitSource);
    console.log(`    → ${d.url || d.id}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
