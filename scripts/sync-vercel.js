#!/usr/bin/env node
/** Sync Vercel projects from projects/*.yaml (env, domain, link repo). Needs DOCS_VERCEL_TOKEN. */

import dotenv from "dotenv";
dotenv.config({ override: false });
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
    const homeUrl = data.project_home_url ?? `https://${fullDomain}`;
    const env = {
      PROJECT_NAME: data.project_name ?? id,
      PROJECT_HOME_URL: homeUrl,
      ACCENT_COLOR: data.accent_color ?? "",
      TINTED_ACCENT_COLOR: data.tinted_accent_color ?? "",
      FOREGROUND_COLOR: data.foreground_color ?? "",
      DATA_URL: data.data_url ?? "",
      NEXT_PUBLIC_PROJECT_NAME: data.project_name ?? id,
      NEXT_PUBLIC_PROJECT_HOME_URL: homeUrl,
      NEXT_PUBLIC_ACCENT_COLOR: data.accent_color ?? "",
      NEXT_PUBLIC_TINTED_ACCENT_COLOR: data.tinted_accent_color ?? "",
      NEXT_PUBLIC_FOREGROUND_COLOR: data.foreground_color ?? "",
      NEXT_PUBLIC_DATA_URL: data.data_url ?? "",
      DOCS_DEPLOYMENT_MANAGED: "1",
      DOCS_DEPLOYMENT_FULL_DOMAIN: fullDomain,
      ...(data.project_env || {}),
    };
    out.push({ id, file, name: data.project_name ?? id, fullDomain, env });
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

/** List all Vercel projects (paginated; we fetch up to 100). */
async function listVercelProjects(token, teamId) {
  const data = await api("GET", "/v10/projects?limit=100", null, token, teamId);
  return Array.isArray(data) ? data : data?.projects ?? [];
}

/** Get env vars for a project (keys and values). */
async function getProjectEnv(token, teamId, idOrName) {
  try {
    const data = await api("GET", `/v10/projects/${encodeURIComponent(idOrName)}/env`, null, token, teamId);
    return Array.isArray(data) ? data : data?.env ?? [];
  } catch (e) {
    if (e.message.includes("404")) return [];
    throw e;
  }
}

/** Delete a Vercel project (and all its deployments). */
async function deleteVercelProject(token, teamId, idOrName) {
  await api("DELETE", `/v9/projects/${encodeURIComponent(idOrName)}`, null, token, teamId);
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

/** List DNS records in a zone (optional type/name filter). */
async function cloudflareListDns(zoneId, token, opts = {}) {
  const q = new URLSearchParams(opts).toString();
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records${q ? `?${q}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || "Cloudflare list DNS failed");
  return data.result || [];
}

/** Delete a CNAME record by name (removes first match). */
async function cloudflareDeleteCNAME(zoneId, token, name) {
  const records = await cloudflareListDns(zoneId, token, { type: "CNAME", name });
  if (records.length === 0) return false;
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${records[0].id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || "Cloudflare delete DNS failed");
  return true;
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

async function main() {
  const token = process.env.DOCS_VERCEL_API_TOKEN || process.env.DOCS_VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) {
    console.error("Set DOCS_VERCEL_TOKEN or DOCS_VERCEL_API_TOKEN (or VERCEL_TOKEN / VERCEL_API_TOKEN) to a Vercel API token.");
    process.exit(1);
  }
  if (token.length < 20 || String(token).startsWith("$")) {
    console.error("Token is wrong: use the real token (vcp_...) as the variable Value in GitLab CI/CD.");
    process.exit(1);
  }

  const config = loadConfig();
  let teamId = process.env.DOCS_VERCEL_TEAM_ID || process.env.VERCEL_TEAM_ID || config.vercel?.teamId;
  if (teamId === "" || !teamId || String(teamId).startsWith("$")) teamId = undefined;
  if (process.env.DOCS_VERCEL_TEAM_ID !== undefined || process.env.VERCEL_TEAM_ID !== undefined) {
    console.log(`Team ID from env → using teamId: ${teamId ?? "personal"}`);
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

    const envToSet = { ...proj.env };
    console.log(`  Setting env vars...`);
    await setProjectEnv(token, teamId, proj.id, envToSet);

    const domains = await listProjectDomains(token, teamId, proj.id);
    const hasDomain = domains.some((d) => d.name === proj.fullDomain);
    if (!hasDomain) {
      console.log(`  Adding domain ${proj.fullDomain}...`);
      await addProjectDomain(token, teamId, proj.id, proj.fullDomain);
    } else {
      console.log(`  Domain ${proj.fullDomain} already added.`);
    }

    const domainInfo = await getProjectDomain(token, teamId, proj.id, proj.fullDomain);
    if (domainInfo && domainInfo.verified === false && Array.isArray(domainInfo.verification) && domainInfo.verification.length > 0) {
      const txtChallenge = domainInfo.verification.find((v) => (v.type || "").toUpperCase() === "TXT");
      if (txtChallenge && txtChallenge.domain && txtChallenge.value) {
        const apex = config.baseDomain || config.dns?.domain;
        const recordName = apex && String(txtChallenge.domain).toLowerCase().endsWith("." + apex.toLowerCase())
          ? txtChallenge.domain.slice(0, -(apex.length + 1)).replace(/\.$/, "")
          : txtChallenge.domain.split(".")[0] || "_vercel";
        const txtFqdn = apex ? `${recordName}.${apex}` : txtChallenge.domain;
        const cfToken = process.env.DOCS_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
        if (config.dns?.provider === "cloudflare" && apex && cfToken) {
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
          console.warn(`  Domain needs TXT at ${txtChallenge.domain} = ${txtChallenge.value}. Set DOCS_CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_TOKEN) and dns.provider=cloudflare to auto-verify.`);
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

  const currentIds = new Set(projects.map((p) => p.id));
  const vercelProjects = await listVercelProjects(token, teamId);
  const candidates = vercelProjects.filter((vp) => !currentIds.has(vp.name));
  if (candidates.length === 0) {
    console.log("\nDone.");
    return;
  }

  const envFromList = (vp) => Array.isArray(vp.env) && vp.env.length > 0 ? vp.env : null;
  const getEnv = async (vp) => envFromList(vp) ?? getProjectEnv(token, teamId, vp.name);
  const envResults = await Promise.all(candidates.map((vp) => getEnv(vp).catch(() => null)));

  const toDelete = [];
  for (let i = 0; i < candidates.length; i++) {
    const envList = envResults[i];
    if (!envList) continue;
    const managed = envList.find((e) => e.key === "DOCS_DEPLOYMENT_MANAGED");
    if (!managed) continue;
    const fullDomainVar = envList.find((e) => e.key === "DOCS_DEPLOYMENT_FULL_DOMAIN");
    toDelete.push({ vp: candidates[i], fullDomain: fullDomainVar?.value });
  }

  if (toDelete.length === 0) {
    console.log("\nDone.");
    return;
  }

  const cfToken = process.env.DOCS_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const dnsConfig = config.dns;

  let zoneId = null;
  if (dnsConfig?.provider === "cloudflare" && cfToken) {
    try {
      zoneId = dnsConfig.zoneId || (await getCloudflareZoneId(dnsConfig.domain, cfToken));
    } catch (e) {
      console.warn(`  Cloudflare zone lookup failed: ${e.message}`);
    }
  }

  await Promise.all(
    toDelete.map(async ({ vp, fullDomain }) => {
      if (zoneId && fullDomain && cfToken) {
        try {
          const removed = await cloudflareDeleteCNAME(zoneId, cfToken, fullDomain);
          if (removed) console.log(`\nRemoved CNAME ${fullDomain} (project ${vp.name} deleted from repo).`);
        } catch (e) {
          console.warn(`  Cloudflare: could not remove CNAME for ${fullDomain}: ${e.message}`);
        }
      }
    })
  );

  await Promise.all(
    toDelete.map(async ({ vp }) => {
      await deleteVercelProject(token, teamId, vp.name);
      console.log(`Deleted Vercel project "${vp.name}" (removed from projects/*.yaml).`);
    })
  );

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
