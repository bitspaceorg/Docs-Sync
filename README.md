# Docs deployment (Vercel)

One GitLab **docs repo** → many **Vercel projects** (one per `projects/*.yaml`). Each has its own env and URL (e.g. `project1.example.com`). Push to docs repo → all linked projects redeploy (sync-vercel links the repo when GitLab is connected to Vercel; else use deploy-docs).

**You do:** Add `projects/<id>.yaml` in **this repo**; set `VERCEL_TOKEN` (and optional `CLOUDFLARE_API_TOKEN`) once; push. **Automated:** Vercel project + env + domain + CNAMEs; repo linking when GitLab is in Vercel. The **docs repo** only holds content; **this repo** defines which projects exist. Initial creation is here; the docs-repo trigger only **updates** (redeploys) those same projects when docs change.

## Config

- **`config.yaml`**: `baseDomain`, `docsRepo.repository`, `docsRepo.projectId` (GitLab numeric ID), `docsRepo.productionBranch`, `vercel.teamId` (optional), `vercel.linkDocsRepo` (default true), `dns.domain`, `dns.vercelCnameTarget` (e.g. `cname.vercel-dns.com`).
- **`projects/<id>.yaml`**: `project_name`, `project_color`, `project_docs_source` (or `project_docsSource`), optional `project_subdomain`, optional `project_env`. Subdomain = custom domain (`subdomain.baseDomain`).

## CI

- **sync-vercel**: Create/update Vercel project per yaml (env, domain, link docs repo). If a domain needs TXT verification (e.g. linked to another Vercel account), sync-vercel can add the `_vercel` TXT via Cloudflare and verify automatically when `dns.provider=cloudflare` and `CLOUDFLARE_API_TOKEN` are set. Needs `VERCEL_TOKEN`.
- **deploy-docs**: Trigger with `DOCS_REF`, `DOCS_SHA` → deploy that commit to every Vercel project. Use if repo isn’t linked.
- **dns**: CNAME each subdomain → Vercel (Cloudflare). On config/projects change or manual. Needs `CLOUDFLARE_API_TOKEN`.

## Secrets

`VERCEL_TOKEN` or `VERCEL_API_TOKEN` (required; use `VERCEL_API_TOKEN` in CI to avoid .env overwriting). Optional: `VERCEL_TEAM_ID`, `CLOUDFLARE_API_TOKEN` (for DNS and TXT verification).

## Trigger from docs repo (updates only)

When the **docs repo** is updated, trigger this repo so deploy-docs redeploys the **existing** projects (no new projects are created—only those in `projects/*.yaml` get the new commit). In the docs repo’s CI:

```yaml
trigger-deployment:
  stage: .post
  script:
    - |
      curl -X POST -F token=${DEPLOYMENT_TRIGGER_TOKEN} \
        -F "variables[DOCS_REF]=${CI_COMMIT_REF_NAME}" \
        -F "variables[DOCS_SHA]=${CI_COMMIT_SHA}" \
        "https://gitlab.com/api/v4/projects/${DEPLOYMENT_PROJECT_ID}/trigger/pipeline"
```

Set `DEPLOYMENT_TRIGGER_TOKEN`, `DEPLOYMENT_PROJECT_ID` in the docs repo (trigger token from this repo’s Settings → CI/CD → Pipeline triggers). This only updates deployments; initial project creation is done in this repo by adding `projects/<id>.yaml` and pushing.

## Commands

```bash
npm run validate
npm run sync-vercel
DOCS_REF=main DOCS_SHA=<sha> npm run deploy-docs
npm run dns
```

If Node isn’t installed globally, use nix: `nix-shell -p nodejs_22 --run "npm ci && npm run sync-vercel"` (or any of the commands above).

## Docs repo

Must accept build-time env: `PROJECT_NAME`, `PROJECT_COLOR`, `DOCS_SOURCE_URL` and `NEXT_PUBLIC_*` (Next.js). sync-vercel sets these. `npm run build`; output `dist/` or `out/` (Next.js).

---

## Testing end-to-end

1. **Prerequisites**
   - Vercel account; [create token](https://vercel.com/account/tokens) → set `VERCEL_TOKEN` locally or `VERCEL_API_TOKEN` in GitLab CI.
   - GitLab docs repo; note its **numeric project ID** (project → Settings → General).
   - (Optional) Cloudflare zone (domain transferred or DNS there) + [API token](https://dash.cloudflare.com/profile/api-tokens) with Zone:DNS:Edit for CNAMEs.

2. **Configure**
   - In `config.yaml`: set `baseDomain`, `docsRepo.repository`, `docsRepo.projectId`, and (if using Cloudflare) `dns.provider: cloudflare`, `dns.domain`, `dns.vercelCnameTarget`.
   - Ensure at least one project exists, e.g. `projects/project1.yaml` with `project_name`, `project_color`, `project_docs_source` (and optional `project_subdomain`).

3. **Validate**
   ```bash
   npm install && npm run validate
   ```
   Fix any reported errors before continuing.

4. **Sync Vercel (local)**
   ```bash
   export VERCEL_TOKEN=your_token
   npm run sync-vercel
   ```
   - Check Vercel dashboard: new projects (e.g. `project1`) with env vars and custom domain `project1.<baseDomain>`.
   - If you see “Could not link docs repo”, connect **GitLab** in Vercel (Settings → Integrations) and run `npm run sync-vercel` again, or use deploy-docs for deploys.

5. **DNS (optional)**
   If using Cloudflare:
   ```bash
   export CLOUDFLARE_API_TOKEN=...
   npm run dns
   ```
   Confirm CNAMEs in Cloudflare (e.g. `project1.<baseDomain>` → `cname.vercel-dns.com`).

6. **Deploy docs**
   - **If repo is linked in Vercel:** Push a change to the docs repo → each linked Vercel project should deploy automatically. Check Vercel Deployments.
   - **If not linked:** Trigger this repo’s pipeline with `DOCS_REF=main` and `DOCS_SHA=<latest_commit_sha>`, or run:
     ```bash
     DOCS_REF=main DOCS_SHA=$(git -C /path/to/docs-repo rev-parse HEAD) npm run deploy-docs
     ```
   Verify each project’s deployment in Vercel.

7. **CI**
   Push `config.yaml` or a file under `projects/` to `main` on this repo. Pipeline should run **sync-vercel** and (if configured) **dns** (Cloudflare). **deploy-docs** runs manually; if you don’t set `DOCS_REF`/`DOCS_SHA`, the job fetches the latest commit from the docs repo (GitLab API) and deploys that. For a private docs repo in another project, add a CI variable with API access (e.g. `GITLAB_TOKEN`) or ensure the job can access the docs project.
