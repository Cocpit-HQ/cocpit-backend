---
name: code-quality
description: >-
  Enforces Cocpit code quality standards (Prettier formatting, ESLint rules,
  TypeScript typecheck, Jest tests), pre-commit verification via lint-staged,
  and Railway continuous deployment with zero-downtime rollbacks. Use whenever
  developing, modifying, or reviewing code, preparing Git commits, or deploying
  backend and frontend services.
---

# Cocpit Code Quality & Deployment Safety Skill

## Overview

This skill defines the development, quality assurance, and deployment standards for the Cocpit monorepo. It ensures that every code change adheres to automated styling, passes static linting and tests, and deploys cleanly to Railway with zero-downtime rollback guarantees.

---

## 1. Automatic Quality Verification Protocol

Whenever you create or modify code in this project, you **MUST** run the following quality checks before concluding your turn:

### In `cocpit-frontend`:

1. **Formatting**: Ensure files comply with `.prettierrc`:
   ```bash
   npx prettier --write <path-to-modified-file>
   ```
2. **Linting**: Ensure zero ESLint errors or unhandled warnings:
   ```bash
   npx eslint --fix <path-to-modified-file>
   ```
3. **Build Check**: If components, routes, or interfaces were heavily altered, verify Next.js compiles without error:
   ```bash
   npm run build
   ```

### In `cocpit-backend`:

1. **Formatting**:
   ```bash
   npx prettier --write <path-to-modified-file>
   ```
2. **Syntax Validation**: Run a syntax check on modified files to catch parse errors or duplicate function declarations:
   ```bash
   node -c <path-to-modified-file>
   ```
3. **Linting**:
   ```bash
   npx eslint --fix <path-to-modified-file>
   ```
4. **Unit Tests**: If services, controllers, or core modules were changed, run the test suite:
   ```bash
   npm test -- --passWithNoTests --forceExit
   ```

> [!IMPORTANT]
> **Zero Unresolved Errors**: Never conclude a task with pending syntax errors, undefined variables (`no-undef`), or unclosed template literals. Fix them immediately before finishing.

---

## 2. Git Commit & Pre-Commit Safety Gates

The project uses **Husky** and **lint-staged** to intercept `git commit`.

1. **How It Works**:
   - Staged files trigger `.husky/pre-commit` ➡️ `npx lint-staged`.
   - `lint-staged` auto-formats files with Prettier and runs `eslint --fix`.
   - If an unfixable error exists, Git blocks the commit immediately.
2. **Rules for Agents & Developers**:
   - **Never bypass hooks**: Do not use `git commit --no-verify`.
   - Before committing, you may dry-run `npx lint-staged` in the respective directory to confirm all staged files pass cleanly.
   - Commit messages must follow conventional commits:
     - `feat: <description>` (new features)
     - `fix: <description>` (bug fixes)
     - `refactor: <description>` (code restructuring)
     - `ci: <description>` (workflows and pipeline changes)
     - `chore: <description>` (dependency updates, configuration)

---

## 3. Pull Request CI/CD Pipeline

Every Pull Request targeting `staging`, `uat`, or `main` automatically runs GitHub Actions on `ubuntu-latest`:

- **Frontend CI** (`.github/workflows/ci.yml`):
  1. `npm ci`
  2. `npm run lint` (ESLint 9)
  3. `npm run build` (Next.js production build check)
- **Backend CI** (`.github/workflows/ci.yml`):
  1. `npm ci`
  2. Syntax checks on entrypoint files (`server.js`, `gateway.js`, `admin.server.js`, `app.js`)
  3. `npm test -- --passWithNoTests --forceExit`
  4. Docker container build dry-run (`docker build .`)

All checks must pass green before merging.

---

## 4. Railway Continuous Deployment & Rollback Protocol

### Architecture & Branch Targets:

- **`staging` branch**:
  - Automatically builds and deploys to Railway **`staging`** environment.
  - Backend URL: `https://cocpit-backend-staging.up.railway.app`
  - Frontend URL: `https://cocpit-frontend-staging.up.railway.app`
- **`uat` branch**:
  - Automatically builds and deploys to Railway **`UAT`** environment.
  - Backend URL: `https://cocpit-backend-uat.up.railway.app`
  - Frontend URL: `https://cocpit-frontend-uat.up.railway.app`

### Zero-Downtime Healthchecks (Smoke Tests):

- Both frontend and backend have automated healthchecks configured in `railway.toml`:
  - Backend: `GET /health` (timeout: 180s)
  - Frontend: `GET /api/health` (timeout: 180s)
- Railway starts the container in a private sandbox and pings the health endpoint. It **only** routes live user traffic once the healthcheck responds HTTP 200. If it fails, the deployment is aborted and the previous container stays live with **0 downtime**.

### Instant Zero-Downtime Rollback:

If a newly merged change causes a production issue, do not wait for code fixes or branch reverts. Roll back immediately using Railway's immutable deployment artifacts:

```powershell
# 1. Check recent deployments and find the last green deployment ID:
railway deployment list -s cocpit-backend -e staging

# 2. Instantly redeploy the previous stable build (takes ~2 seconds, zero rebuild required):
railway deployment redeploy <LAST_STABLE_DEPLOYMENT_ID>
```

---

## 5. Common Pitfalls & Auto-Recovery

- **ESLint `no-undef`**: Usually caused by missing `import` or misspelled variable. Find where the variable is defined and import it cleanly.
- **Duplicate function declaration**: In JavaScript, declaring `async function foo()` twice in the same scope throws a fatal parse error. Always search the file before declaring helper functions.
- **Corrupted `.next` build cache**: If `npm run build` fails with stale type references in `.next/dev/types`, delete `.next` (`Remove-Item -Recurse -Force .next`) and re-run `npm run build`.
- **Database / Redis connection errors**: Verify Railway environment variables (`DATABASE_URL`, `REDIS_URL`) and check runtime logs with `railway logs`.
