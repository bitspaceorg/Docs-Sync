#!/usr/bin/env node
/** CNAME each project subdomain → dns.vercelCnameTarget in GoDaddy. Needs GODADDY_API_KEY, GODADDY_API_SECRET. */

import dotenv from "dotenv";
dotenv.config({ override: false }); // CI vars win; .env only fills in unset vars
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GODADDY_API = process.env.GODADDY_API_URL || "https://api.godaddy.com";

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

async function putCNAME(domain, name, key, secret, target) {
  const url = `${GODADDY_API}/v1/domains/${encodeURIComponent(domain)}/records/CNAME/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `sso-key ${key}:${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ data: target, ttl: 600 }]),
  });
  if (!res.ok) throw new Error(`GoDaddy ${res.status}: ${await res.text()}`);
}

async function main() {
  const config = loadConfig();
  const dns = config.dns;
  if (!dns || dns.provider !== "godaddy" || !dns.domain) {
    console.log("Skip: dns.provider is not godaddy or dns.domain missing.");
    process.exit(0);
  }
  const key = process.env.GODADDY_API_KEY;
  const secret = process.env.GODADDY_API_SECRET;
  if (!key || !secret) {
    console.error("Set GODADDY_API_KEY and GODADDY_API_SECRET");
    process.exit(1);
  }
  const target = dns.vercelCnameTarget || "cname.vercel-dns.com";
  const projects = loadProjects(config);
  console.log(`GoDaddy: ${projects.length} CNAME(s) -> ${target}`);
  for (const p of projects) {
    await putCNAME(dns.domain, p.subdomain, key, secret, target);
    console.log(`  ${p.fullDomain}`);
  }
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
