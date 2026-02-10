#!/usr/bin/env node
/** CNAME each project subdomain → dns.vercelCnameTarget in Cloudflare. Needs CLOUDFLARE_API_TOKEN. */

import dotenv from "dotenv";
dotenv.config({ override: false });
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CF_API = "https://api.cloudflare.com/client/v4";

function loadConfig() {
  return parse(fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8"));
}

function loadProjects(config) {
  const projectsDir = path.join(ROOT, "projects");
  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"));
  return files.map((file) => {
    const id = path.basename(file, ".yaml");
    const data = parse(fs.readFileSync(path.join(projectsDir, file), "utf8"));
    const subdomain = data.project_subdomain ?? id;
    return { subdomain, fullDomain: `${subdomain}.${config.baseDomain}` };
  });
}

async function cf(method, pathname, body, token) {
  const url = pathname.startsWith("http") ? pathname : `${CF_API}${pathname}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.errors?.[0]?.message || data.message || res.statusText;
    throw new Error(`Cloudflare ${res.status}: ${msg}`);
  }
  if (data.success === false) {
    const msg = data.errors?.[0]?.message || "Unknown error";
    throw new Error(`Cloudflare: ${msg}`);
  }
  return data;
}

async function getZoneId(domain, token) {
  const data = await cf("GET", `/zones?name=${encodeURIComponent(domain)}`, null, token);
  const zone = data.result?.[0];
  if (!zone?.id) throw new Error(`Zone not found for domain: ${domain}`);
  return zone.id;
}

async function listDnsRecords(zoneId, token, params = {}) {
  const q = new URLSearchParams(params).toString();
  const data = await cf("GET", `/zones/${zoneId}/dns_records${q ? `?${q}` : ""}`, null, token);
  return data.result || [];
}

async function createDnsRecord(zoneId, token, record) {
  return await cf("POST", `/zones/${zoneId}/dns_records`, record, token);
}

async function updateDnsRecord(zoneId, token, recordId, record) {
  return await cf("PUT", `/zones/${zoneId}/dns_records/${recordId}`, record, token);
}

async function upsertCNAME(zoneId, token, name, content) {
  const existing = await listDnsRecords(zoneId, token, { type: "CNAME", name });
  const payload = {
    type: "CNAME",
    name,
    content: content.endsWith(".") ? content : `${content}.`,
    ttl: 600,
    proxied: false,
  };
  if (existing.length > 0) {
    await updateDnsRecord(zoneId, token, existing[0].id, payload);
    return "updated";
  }
  await createDnsRecord(zoneId, token, payload);
  return "created";
}

async function main() {
  const config = loadConfig();
  const dns = config.dns;
  if (!dns || dns.provider !== "cloudflare" || !dns.domain) {
    console.log("Skip: dns.provider is not cloudflare or dns.domain missing.");
    process.exit(0);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error("Set CLOUDFLARE_API_TOKEN (Cloudflare API token with Zone:DNS:Edit).");
    process.exit(1);
  }
  const target = dns.vercelCnameTarget || "cname.vercel-dns.com";
  const zoneId = dns.zoneId || (await getZoneId(dns.domain, token));
  const projects = loadProjects(config);
  console.log(`Cloudflare: ${projects.length} CNAME(s) -> ${target} (zone: ${dns.domain})`);
  for (const p of projects) {
    const status = await upsertCNAME(zoneId, token, p.fullDomain, target);
    console.log(`  ${p.fullDomain} (${status})`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
