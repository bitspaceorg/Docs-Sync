#!/usr/bin/env node
/** Validate config.yaml and projects/*.yaml. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadConfig() {
  const p = path.join(ROOT, "config.yaml");
  if (!fs.existsSync(p)) {
    console.error("Missing config.yaml");
    process.exit(1);
  }
  return parse(fs.readFileSync(p, "utf8"));
}

function validateConfig(config) {
  const errs = [];
  if (!config.baseDomain) errs.push("config.baseDomain is required");
  if (!config.docsRepo?.repository) errs.push("config.docsRepo.repository is required (e.g. owner/repo)");
  if (!config.docsRepo?.projectId) errs.push("config.docsRepo.projectId is required (GitLab numeric project ID for deploy-docs)");
  return errs;
}

function validateProject(id, data) {
  const errs = [];
  if (!data.project_name) errs.push(`${id}: project_name is required`);
  if (!data.accent_color && !data.project_env?.ACCENT_COLOR) errs.push(`${id}: accent_color (or project_env.ACCENT_COLOR) is recommended`);
  if (!data.data_url && !data.project_env?.DATA_URL) errs.push(`${id}: data_url (or project_env.DATA_URL) is recommended`);
  return errs;
}

function main() {
  const config = loadConfig();
  const configErrs = validateConfig(config);
  if (configErrs.length) {
    console.error("Config errors:\n  " + configErrs.join("\n  "));
    process.exit(1);
  }

  const projectsDir = path.join(ROOT, "projects");
  if (!fs.existsSync(projectsDir)) {
    console.error("Missing projects/ directory");
    process.exit(1);
  }

  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"));
  let any = false;
  for (const file of files) {
    const id = path.basename(file, ".yaml");
    const raw = fs.readFileSync(path.join(projectsDir, file), "utf8");
    let data;
    try {
      data = parse(raw);
    } catch (e) {
      console.error(`${file}: invalid YAML: ${e.message}`);
      any = true;
      continue;
    }
    const errs = validateProject(id, data);
    if (errs.length) {
      console.error(`${file}:\n  ` + errs.join("\n  "));
      any = true;
    }
  }

  if (any) process.exit(1);
}

main();
