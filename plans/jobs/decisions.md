# Architecture Decision Record: Jobs Domain

## Decision 001: POST /jobs creates Draft
**Reason:** Supports manual creation and future AI generation natively without creating distinct endpoint flows for drafts vs. published jobs.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs API

## Decision 002: Null-safe Database Constraints
**Reason:** Allows for partial drafts without weakening the database-level protections for published jobs. Example: `salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max`.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs Database Schema

## Decision 003: PATCH for Updates
**Reason:** Draft creation and AI-assisted creation involve iterative, partial updates. `PATCH` is the semantically correct REST method and reduces payload size.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs API

## Decision 004: Versioning Triggers
**Reason:** We will create `job_versions` only on explicit checkpoints (Manual Save, AI Generate, Submit, Approve) rather than every `PATCH` to prevent table bloat.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs Service, Job Versions

## Decision 005: Job Activity Audit Log
**Reason:** Critical for tracking the ATS lifecycle. We need an explicit `job_activity` table to track events like `Draft Created`, `Edited`, `Submitted`, `Approved`, `Closed`.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs Database Schema, Jobs Service

## Decision 006: Separation of Validation Layers
**Reason:** `PATCH` requests will undergo strict Schema Validation (types) but NO Business Validation. Business Validation (e.g., salary min <= max, description length) is deferred until the `POST /jobs/:id/submit` action.
**Status:** Approved
**Date:** 2026-06-21
**Affected Modules:** Jobs Validation Layer