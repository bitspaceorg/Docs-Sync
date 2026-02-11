# Docs Sync

One docs repo → many Vercel projects (one per `projects/*.yaml`). This repo defines projects and syncs them to Vercel; the docs repo holds content. Push here → Vercel projects + env + domains; push to docs repo (or trigger) → redeploy.

## Config

- **config.yaml**: `baseDomain`, `docsRepo.repository`, `docsRepo.projectId` (GitLab numeric ID), `docsRepo.productionBranch`, optional `vercel.teamId`, `dns.domain`, `dns.vercelCnameTarget`.
- **projects/<id>.yaml**: Env-style keys (sync-vercel pushes these to Vercel as `PROJECT_NAME`, `PROJECT_HOME_URL`, `ACCENT_COLOR`, `TINTED_ACCENT_COLOR`, `FOREGROUND_COLOR`, `DATA_URL` and `NEXT_PUBLIC_*`):

  | YAML key | Env var | Example |
  |----------|---------|---------|
  | `project_name` | `PROJECT_NAME` | `Zide` |
  | `project_home_url` | `PROJECT_HOME_URL` | `https://zide.bitspace.org.in` |
  | `accent_color` | `ACCENT_COLOR` | `#CCFF00` |
  | `tinted_accent_color` | `TINTED_ACCENT_COLOR` | `#FBFFEB` |
  | `foreground_color` | `FOREGROUND_COLOR` | `#0A0A0A` |
  | `data_url` | `DATA_URL` | `https://api.docs.zide.bitspace.org.in` or `http://localhost:8000/data.json` |

  Optional: `project_subdomain` (defaults to file id for domain); `project_env` (extra env key/values).

## CI jobs

| Job | When | Needs |
|-----|------|--------|
| **sync-vercel** | main, config/projects change (not on trigger) | DOCS_VERCEL_TOKEN |
| **dns:cloudflare** | main, config/projects change | DOCS_CLOUDFLARE_API_TOKEN |
| **deploy-docs** | trigger with DOCS_SHA, or main config/projects change, or manual | DOCS_VERCEL_TOKEN, DOCS_SHA (or from get-latest) |

Removing a `projects/<id>.yaml` and running sync-vercel deletes that Vercel project and its Cloudflare CNAME (if DNS is Cloudflare).

## Secrets

- **DOCS_VERCEL_TOKEN** (or VERCEL_TOKEN) — required for sync and deploy.
- **DOCS_CLOUDFLARE_API_TOKEN** (or CLOUDFLARE_API_TOKEN) — optional; for DNS and TXT verification.
- **DOCS_VERCEL_TEAM_ID** — optional; for Vercel team.

## Trigger from docs repo

In the docs repo CI (e.g. on push to main), trigger this repo so deploy-docs runs:

```yaml
- curl -X POST -F token=${DOCS_DEPLOYMENT_TRIGGER_TOKEN} -F ref=main \
    -F "variables[DOCS_REF]=${CI_COMMIT_REF_NAME}" -F "variables[DOCS_SHA]=${CI_COMMIT_SHA}" \
    "https://gitlab.com/api/v4/projects/${DOCS_DEPLOYMENT_PROJECT_ID}/trigger/pipeline"
```

Set **DOCS_DEPLOYMENT_TRIGGER_TOKEN** and **DOCS_DEPLOYMENT_PROJECT_ID** in the docs repo (token from this repo: Settings → CI/CD → Pipeline triggers). `ref` is the branch in **this** repo (e.g. main).

## Commands

```bash
npm run validate
npm run sync-vercel
npm run dns
DOCS_REF=main DOCS_SHA=<sha> npm run deploy-docs
```

## Docs app

Expect at build/runtime: `PROJECT_NAME`, `PROJECT_HOME_URL`, `ACCENT_COLOR`, `TINTED_ACCENT_COLOR`, `FOREGROUND_COLOR`, `DATA_URL`. sync-vercel sets these from project yaml.