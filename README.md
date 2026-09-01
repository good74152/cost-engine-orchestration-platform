# Financial Calculation Platform

A production-style backend platform for long-running, versioned financial calculation workflows.

The project explores backend architecture patterns for data-intensive financial systems that require reproducibility, concurrency correctness, asynchronous execution, and database reliability.

> Status: In Progress

## Problem

Large financial calculation workflows often involve:

- Millions of input records
- Long-running calculations
- Dependencies on upstream datasets
- Concurrent calculation requests
- Reproducible calculation results
- Database-heavy processing
- Failure recovery and operational visibility

Instead of treating a calculation as a single synchronous API request, this project models calculations as versioned jobs with explicit lifecycle and data dependencies.

## Tech Stack

- TypeScript
- Node.js / Fastify
- PostgreSQL
- Docker / Docker Compose

## Architecture

Current high-level workflow:

```text
Raw Ingestion
      ↓
Versioned Raw Batch
      ↓
Immutable Calculation Input
      ↓
Calculation Job
      ↓
Dataset Version
      ↓
Published Result
```

## Implemented

### Versioned Calculation Workflow

- Dataset Series and Dataset Versions
- Calculation Jobs
- Dependency version pinning
- Transactional job and dataset state transitions
- Explicit lifecycle states for calculation outputs

### Database Reliability

- Atomic version allocation
- Partial unique indexes
- Composite foreign keys
- Compare-and-set state transitions
- Database-level concurrency invariants
- Concurrent request testing

Concurrency behavior is validated with 20 simultaneous requests and post-test database assertions to verify that conflicting operations result in a single valid state transition.

### PostgreSQL Performance Lab

A synthetic financial dataset was created with:

- 4M raw financial rows
- 250K assets
- Quarterly table partitions

`EXPLAIN (ANALYZE, BUFFERS)` was used to investigate:

- Partition pruning
- Sequential scans
- Bitmap index and heap scans
- Hash joins
- Index trade-offs
- Aggregation pushdown
- Hash aggregation spill
- Materialized calculation-ready datasets

## Current Work

Currently implementing:

- Versioned raw ingestion
- Raw ingestion batch lifecycle
- Immutable calculation input snapshots
- Reconciliation and auditability
- Asynchronous calculation execution

## Design Principles

- Calculation inputs should be reproducible.
- Published datasets should be immutable.
- Database constraints should enforce critical invariants.
- Long-running calculations should not block HTTP requests.
- Performance decisions should be based on execution-plan evidence rather than assumptions.

## Local Development

### Requirements

- Node.js 24+
- Docker
- Docker Compose

### Setup

```bash
cp .env.example .env
npm install
docker compose up -d
npm run migrate up
npm run dev
```

## Project Status

This project is actively under development and is being expanded toward a production-style asynchronous calculation platform.
