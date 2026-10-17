# 📘 Git & Branching Guidelines

This document defines how we use Git in this project.
All developers must follow these rules to ensure clean history, stable deployments, and smooth collaboration.

---

# 🌳 1. Branching Strategy

We follow a **Trunk-Based Development approach**.

## Main Branches

* `main` → Production (always stable)
* `develop` → Staging / integration

---

## Working Branches

Create branches from `develop`:

* `feature/<feature-name>` → New features
* `bugfix/<bug-name>` → Bug fixes
* `hotfix/<issue-name>` → Urgent production fixes

### Examples:

* `feature/user-authentication`
* `bugfix/login-error`
* `hotfix/payment-crash`

---

# 🔁 2. Development Workflow

Follow this flow strictly:

```bash
feature/* → develop → main
```

### Steps:

1. Pull latest code

```bash
git checkout develop
git pull origin develop
```

2. Create a new branch

```bash
git checkout -b feature/<feature-name>
```

3. Work on your changes

4. Commit changes (see commit rules below)

5. Push branch

```bash
git push origin feature/<feature-name>
```

6. Create a Pull Request (PR) → `develop`

---

# 🧾 3. Commit Message Convention

We follow **Conventional Commits**.

## Format:

```bash
type: short description
```

## Types:

* `feat:` → New feature
* `fix:` → Bug fix
* `refactor:` → Code improvement
* `docs:` → Documentation
* `chore:` → Misc changes

### Examples:

```bash
feat: add user authentication API
fix: resolve token expiration issue
refactor: optimize database queries
docs: update API documentation
```

---

# 📦 4. Committing Code

## Stage changes:

```bash
git add .
```

## Commit:

```bash
git commit -m "feat: add login functionality"
```

---

# 🚀 5. Pushing Code

Push your branch to remote:

```bash
git push origin <branch-name>
```

Example:

```bash
git push origin feature/login-api
```

---

# 🔀 6. Pull Request Rules

* Always create PR to `develop` (NOT `main`)
* Add proper description
* Mention what was changed and why
* Ensure code is tested before PR

---

# ❌ 7. Important Rules

* ❌ Never push directly to `main` or `develop`

* ❌ Never commit secrets (.env, API keys)

* ❌ Do not create large PRs (>400 lines recommended)

* ✅ Always pull latest before starting work

* ✅ Always use proper branch naming

* ✅ Always follow commit format

---

# 🧹 8. Branch Cleanup

* Delete branch after PR is merged
* Do not reuse old branches

---

# ⚠️ 9. Quick Commands Reference

```bash
# Create branch
git checkout -b feature/<name>

# Check status
git status

# Add changes
git add .

# Commit
git commit -m "feat: message"

# Push
git push origin <branch>

# Pull latest
git pull origin develop

# Delete local branch
git branch -d <branch>
```

---

# 🎯 10. Summary

* Work only on feature/bugfix branches
* Create PR → `develop`
* Follow commit conventions
* Keep code clean and tested

---

Following these guidelines ensures:

* Stable production
* Clean Git history
* Smooth collaboration across the team
