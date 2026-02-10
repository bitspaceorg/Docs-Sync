#!/usr/bin/env node
/** Create/update Vercel project per projects/*.yaml (env, domain, link docs repo). Needs VERCEL_TOKEN. */

import dotenv from "dotenv";
dotenv.config({ override: false }); // CI vars win; .env only fills in unset vars
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

function loadProjects(config) {
  const projectsDir = path.join(ROOT, "projects");
  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"));
  const out = [];
  for (const file of files) {
    const id = path.basename(file, ".yaml");
    const raw = fs.readFileSync(path.join(projectsDir, file), "utf8");
    const data = parse(raw);
    const subdomain = data.project_subdomain ?? id;
    const fullDomain = `${subdomain}.${config.baseDomain}`;
    const docsSource = data.project_docs_source ?? data.project_docsSource ?? "";
    const env = {
      PROJECT_NAME: data.project_name,
      PROJECT_COLOR: data.project_color ?? "",
      DOCS_SOURCE_URL: docsSource,
      NEXT_PUBLIC_PROJECT_NAME: data.project_name,
      NEXT_PUBLIC_PROJECT_COLOR: data.project_color ?? "",
      NEXT_PUBLIC_DOCS_SOURCE_URL: docsSource,
      ...(data.project_env || {}),
    };
    out.push({ id, file, name: data.project_name, fullDomain, env });
  }
  return out;
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

async function getProject(token, teamId, idOrName) {
  try {
    return await api("GET", `/v9/projects/${encodeURIComponent(idOrName)}`, null, token, teamId);
  } catch (e) {
    if (e.message.includes("404")) return null;
    throw e;
  }
}

async function createProject(token, teamId, name) {
  return await api("POST", "/v11/projects", { name }, token, teamId);
}

async function listProjectDomains(token, teamId, idOrName) {
  const r = await api("GET", `/v9/projects/${encodeURIComponent(idOrName)}/domains`, null, token, teamId);
  return r.domains || [];
}

async function addProjectDomain(token, teamId, idOrName, domainName) {
  return await api("POST", `/v10/projects/${encodeURIComponent(idOrName)}/domains`, { name: domainName }, token, teamId);
}

/** GET project domain (includes verification challenges if not verified). */
async function getProjectDomain(token, teamId, idOrName, domainName) {
  try {
    return await api("GET", `/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domainName)}`, null, token, teamId);
  } catch (e) {
    if (e.message.includes("404")) return null;
    throw e;
  }
}

/** Trigger domain verification (after TXT record is in place). */
async function verifyProjectDomain(token, teamId, idOrName, domainName) {
  return await api("POST", `/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domainName)}/verify`, null, token, teamId);
}

const CF_API = "https://api.cloudflare.com/client/v4";

/** Add or replace TXT record at Cloudflare (for Vercel domain verification). */
async function cloudflarePutTXT(zoneId, token, name, value) {
  const listRes = await fetch(`${CF_API}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json();
  const existing = listData.result || [];
  const payload = { type: "TXT", name, content: value, ttl: 600 };
  if (existing.length > 0) {
    const put = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${existing[0].id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!put.ok) throw new Error(`Cloudflare TXT ${put.status}: ${await put.text()}`);
    return;
  }
  const post = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!post.ok) throw new Error(`Cloudflare TXT ${post.status}: ${await post.text()}`);
}

async function getCloudflareZoneId(domain, token) {
  const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const zone = data.result?.[0];
  if (!zone?.id) throw new Error(`Cloudflare zone not found: ${domain}`);
  return zone.id;
}

async function setProjectEnv(token, teamId, idOrName, env) {
  const target = ["production", "preview"];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    await api("POST", `/v10/projects/${encodeURIComponent(idOrName)}/env?upsert=true`, {
      key,
      value: String(value),
      type: "plain",
      target,
    }, token, teamId);
  }
}

/** Try to link the GitLab docs repo to this Vercel project so pushes auto-deploy. Requires GitLab connected to Vercel. */
async function linkProjectToDocsRepo(token, teamId, vercelProjectId, integrationConfigurationId, gitLabProjectId) {
  const pathname = `/v1/integrations/installations/${encodeURIComponent(integrationConfigurationId)}/resources/${encodeURIComponent(String(gitLabProjectId))}/connections`;
  const url = new URL(pathname, VERCEL_API);
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ projectId: vercelProjectId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
}

/** Get first GitLab integration configuration id for the account/team. */
async function getGitLabIntegrationConfigId(token, teamId) {
  const url = new URL("/v1/integrations/configurations", VERCEL_API);
  url.searchParams.set("view", "account");
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const configs = await res.json();
  if (!Array.isArray(configs)) return null;
  const gitlab = configs.find((c) => (c.slug || "").toLowerCase() === "gitlab" && c.status === "ready");
  return gitlab?.id ?? null;
}

const SENSITIVE_KEYS = new Set(["VERCEL_TOKEN", "VERCEL_API_TOKEN", "CLOUDFLARE_API_TOKEN"]);

function debugPrintEnv() {
  // console.log("--- env (sensitive values redacted) ---");
  // const keys = Object.keys(process.env).filter((k) => k.startsWith("VERCEL_") || k.startsWith("CLOUDFLARE_") || k.startsWith("DOCS_") || k === "CI" || k === "GITLAB_CI");
  // keys.sort();
  // for (const k of keys) {
    // const v = process.env[k];
    //   console.log(`${k}=${JSON.stringify(v)}`);
  // }
  // console.log("--- end env ---");
}

async function main() {
  debugPrintEnv();

  // Prefer VERCEL_API_TOKEN (e.g. in CI) so .env VERCEL_TOKEN cannot overwrite it
  const token = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("Set VERCEL_API_TOKEN or VERCEL_TOKEN to a Vercel API token (e.g. from vercel.com/account/tokens)");
    process.exit(1);
  }
  const tokenSource = process.env.VERCEL_API_TOKEN ? "VERCEL_API_TOKEN" : "VERCEL_TOKEN";
  console.log(`${tokenSource} set: yes, length=${token.length}`);
  if (token.length < 20 || token.startsWith("$")) {
    console.error(`Token (${tokenSource}) is wrong: use the real token (vcp_...) as the variable Value in GitLab CI/CD.`);
    process.exit(1);
  }

  const config = loadConfig();
  let teamId = process.env.VERCEL_TEAM_ID || config.vercel?.teamId;
  if (teamId === "" || !teamId || String(teamId).startsWith("$")) teamId = undefined;
  if (process.env.VERCEL_TEAM_ID !== undefined) {
    console.log(`VERCEL_TEAM_ID from env: "${process.env.VERCEL_TEAM_ID}" → using teamId: ${teamId ?? "personal"}`);
  }
  const docsRepo = config.docsRepo;
  const projects = loadProjects(config);
  const shouldLinkRepo = config.vercel?.linkDocsRepo !== false && docsRepo?.projectId;

  let gitLabConfigId = null;
  if (shouldLinkRepo) {
    gitLabConfigId = await getGitLabIntegrationConfigId(token, teamId);
    if (!gitLabConfigId) {
      console.log("GitLab integration not found in Vercel; skip linking. Connect GitLab in Vercel Settings → Integrations for auto-link.");
    }
  }

  console.log(`Syncing ${projects.length} project(s) to Vercel (teamId: ${teamId || "personal"})...`);

  for (const proj of projects) {
    console.log(`\n--- ${proj.id} (${proj.name}) ---`);
    let project = await getProject(token, teamId, proj.id);
    if (!project) {
      console.log(`  Creating project "${proj.id}"...`);
      project = await createProject(token, teamId, proj.id);
    } else {
      console.log(`  Project exists.`);
    }

    console.log(`  Setting env vars...`);
    await setProjectEnv(token, teamId, proj.id, proj.env);

    const domains = await listProjectDomains(token, teamId, proj.id);
    const hasDomain = domains.some((d) => d.name === proj.fullDomain);
    if (!hasDomain) {
      console.log(`  Adding domain ${proj.fullDomain}...`);
      await addProjectDomain(token, teamId, proj.id, proj.fullDomain);
    } else {
      console.log(`  Domain ${proj.fullDomain} already added.`);
    }

    // If domain needs TXT verification (e.g. linked to another account), add TXT via DNS provider and verify
    const domainInfo = await getProjectDomain(token, teamId, proj.id, proj.fullDomain);
    if (domainInfo && domainInfo.verified === false && Array.isArray(domainInfo.verification) && domainInfo.verification.length > 0) {
      const txtChallenge = domainInfo.verification.find((v) => (v.type || "").toUpperCase() === "TXT");
      if (txtChallenge && txtChallenge.domain && txtChallenge.value) {
        const apex = config.baseDomain || config.dns?.domain;
        const recordName = apex && String(txtChallenge.domain).toLowerCase().endsWith("." + apex.toLowerCase())
          ? txtChallenge.domain.slice(0, -(apex.length + 1)).replace(/\.$/, "")
          : txtChallenge.domain.split(".")[0] || "_vercel";
        const txtFqdn = apex ? `${recordName}.${apex}` : txtChallenge.domain;
        if (config.dns?.provider === "cloudflare" && apex && process.env.CLOUDFLARE_API_TOKEN) {
          const cfToken = process.env.CLOUDFLARE_API_TOKEN;
          const zoneId = config.dns.zoneId || (await getCloudflareZoneId(apex, cfToken));
          console.log(`  Adding TXT ${txtFqdn} for verification...`);
          await cloudflarePutTXT(zoneId, cfToken, txtFqdn, txtChallenge.value);
          await new Promise((r) => setTimeout(r, 8000));
          const after = await verifyProjectDomain(token, teamId, proj.id, proj.fullDomain);
          if (after?.verified) {
            console.log(`  Domain verified.`);
          } else {
            console.warn(`  Verification may still be pending; check Vercel dashboard or re-run sync later.`);
          }
        } else {
          console.warn(`  Domain needs TXT at ${txtChallenge.domain} = ${txtChallenge.value}. Set CLOUDFLARE_API_TOKEN and dns.provider=cloudflare to auto-verify.`);
        }
      }
    }

    if (shouldLinkRepo && gitLabConfigId && project.id) {
      try {
        await linkProjectToDocsRepo(token, teamId, project.id, gitLabConfigId, docsRepo.projectId);
        console.log(`  Linked to docs repo (GitLab project ${docsRepo.projectId}); pushes will auto-deploy.`);
      } catch (e) {
        console.warn(`  Could not link docs repo automatically: ${e.message}. Connect in Vercel Settings → Git or use deploy-docs.`);
      }
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
