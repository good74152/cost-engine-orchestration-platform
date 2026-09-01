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
- Node.js
- Fastify
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