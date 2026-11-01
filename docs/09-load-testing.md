# Phase 9 — Load Testing (IN PROGRESS)

> Status: read-path experiments done and a real bottleneck fixed. Login measured. The upload run was
> invalid because the laptop's disk filled up mid-test. Still to do: re-run uploads and the mixed
> scenario on a machine with free disk, then close this phase.

## BEFORE

### 1. Goal

Not "how many requests per second can we do", but **what breaks first, with evidence**: which resource
saturates (CPU, event loop, database, MinIO, network, disk), and does fixing it actually help?

### 2. Method

1. Generate load with **k6** (runs in Docker, no install): scripted users with thresholds.
2. Watch **Prometheus/Grafana** (Phase 8) and `docker stats`/`ps` during the run.
3. Find the saturated resource → profile if needed → change ONE thing → re-run the same test.

### 3. Scenarios ([`loadtest/ministore.js`](../loadtest/ministore.js))

| Scenario | What a virtual user does | Load shape |
|---|---|---|
| `read` | list files, then mint a presigned URL | ramp 50 → `PEAK` (default 1500) iterations/s |
| `steady` | same as read | fixed `RATE` for `DURATION` (for profiling and before/after) |
| `login` | log in (scrypt) | ramp 5 → 150/s |
| `upload` | upload 1 MiB, then permanently delete it | 20 concurrent users, 60 s |
| `mixed` | 200 reads/s + 10 uploads/s + 5 logins/s together | 60 s |

```bash
docker compose --profile observability up -d
cd backend && AUTH_RATE_LIMIT=1000000 LIFECYCLE_INTERVAL_MINUTES=0 WEB_CONCURRENCY=4 npx tsx src/server.ts
docker compose run --rm k6 run -e SCENARIO=read -e PEAK=4000 /scripts/ministore.js
```

`AUTH_RATE_LIMIT` must be raised: k6's `setup()` logs in 10 users from one IP and would get 429 —
which is itself a finding (see "Findings" below).

**Test machine:** MacBook Air, 8 cores, 8 GB RAM. k6, Postgres, MinIO and the API all share it.

---

## AFTER (so far)

### Experiment 1 — read path, single process

| Measure | Result |
|---|---|
| Peak throughput | **~550 iterations/s ≈ 1,100 requests/s** |
| p95 latency | 374 ms (threshold 300 ms ✗) |
| Dropped iterations (k6 couldn't start them) | 20,929 |
| Errors | 0 |

Evidence from Prometheus during the run:

| Resource | Value | Saturated? |
|---|---|---|
| API process CPU | **1.00 core** | **yes — Node runs JS on one thread** |
| Event-loop lag p99 | 31 ms | rising |
| Postgres / MinIO containers | ~0% / ~0% | no |
| API memory | 195 MB | no |

### Profiling (`node --cpu-prof`, 400 iterations/s for 20 s)

Where the busy CPU time went:

| Component | Share |
|---|---|
| AWS SDK (presigning URLs) | 18.5% |
| Prisma + pg (database client) | 15.6% |
| HTTP + Express | 15.1% |
| crypto (JWT verify, HMAC) | 8.7% |
| logging (pino) | 1.1% |
| metrics (prom-client) | 0.5% |
| everything else (runtime, microtasks, I/O) | 40.3% |

**No single hot spot.** Optimising any one piece would gain little. Observability costs < 2%.
The real limit is using one core out of eight.

### Fix — one worker process per core (`WEB_CONCURRENCY`)

[`backend/src/server.ts`](../backend/src/server.ts) now uses `node:cluster`: a primary forks
`WEB_CONCURRENCY` workers that share port 3000, restarts any that crash, serves `/metrics` merged from
all workers (prom-client `AggregatorRegistry`), and runs the lifecycle job once.

Bug found on the way: metrics scrapes timed out (HTTP 500). In prom-client 15 the worker-side listener
is installed by the `AggregatorRegistry` **constructor**; calling only `setRegistries` in workers
silently never answers.

### Experiment 2 — read path, 4 workers

| Test | Throughput | p95 | Dropped | Errors |
|---|---|---|---|---|
| Ramp to 1500/s (same as experiment 1) | handled the whole ramp | **10 ms** (was 374 ms) | **9** (was 20,929) | 0 |
| Steady 1500 iterations/s for 40 s | **2,794 requests/s** | 56 ms | 713 | 0 |
| Ramp to 4000/s, 4 workers | ~1,900 req/s average | 495 ms | 90k | 0 |
| Ramp to 4000/s, **7 workers** | ~1,580 req/s average (worse) | 649 ms | 104k | 0 |

### Experiment 3 — why more workers made it WORSE

CPU of every process during the steady 1500/s run:

| Process | CPU |
|---|---|
| Docker VM (k6 117% + Postgres 128% + overhead) | 337% |
| Docker networking (`com.docker.backend`) | 101% |
| 4 API workers | 52–75% each — **not saturated** |

**The laptop is the new bottleneck**: the load generator and Docker's port forwarding use ~4.5 of 8 cores.
More workers only compete with them for CPU. Lesson: **the load generator must run on a different
machine**, or you end up measuring the test rig. Postgres at 128% CPU is the next bottleneck on real
hardware (every read does 2 queries).

### Experiment 4 — login

| Measure | Result |
|---|---|
| Throughput | ~60 logins/s at best (target ramp 150/s) |
| p95 | **5.7 s** (threshold 1 s ✗) |
| Errors | 0, but 2,427 iterations dropped |
| API CPU | up to 6.7 cores |

scrypt is **deliberately** slow and memory-hard (32 MiB, ~tens of ms of CPU per hash) so stolen
password hashes are expensive to crack. It runs on libuv's thread pool (4 threads per process by default).
This is a **designed** ceiling, not a bug. Options if it mattered: more cores, `UV_THREADPOOL_SIZE`,
longer-lived sessions so users log in less often, or a separate auth service. Never weaken the hash.

### Experiment 5 — upload: INVALID, must be re-run

48% of uploads failed and p95 was 2.7 s — because **the laptop's disk filled up** during the run
(`no space left on device`). These numbers say nothing about the API. Re-run with ≥ 5 GB free.

### Findings so far

1. Single-process Node.js caps at one core → fixed with `cluster` (2.5× throughput, p95 374 → 56 ms).
2. On one laptop, the load generator and Docker networking become the bottleneck next.
3. Login is CPU-bound by design (scrypt).
4. **The per-IP auth rate limit (20 per 15 min) blocks everyone behind one IP** — the load test hit it
   during setup. Real offices/universities share an IP (NAT). Better: limit per email *and* per IP, with
   a higher per-IP ceiling.
5. **Disk is a resource too**: Docker's disk image grows and does not shrink by itself. Monitor free disk
   (an alert on MinIO's `minio_cluster_capacity_usable_free_bytes` belongs in Phase 8's rules).
6. With `WEB_CONCURRENCY` workers, the in-memory rate limiter allows N × the limit (noted in code).
7. Postgres connection pool: each process opens up to 10 connections; 8 workers + primary ≈ 90 of
   Postgres' default 100. Size the pool (or use PgBouncer) before adding more processes.

### To finish this phase

- [ ] Free disk space (≥ 5 GB), re-run `upload` and `mixed`
- [ ] Add a low-disk alert rule
- [ ] Decide on per-email login rate limiting
- [ ] Interview questions section

### Interview questions (draft)

1. How do you find the bottleneck in a load test? What did you look at first?
2. Why does a Node.js process top out at one CPU core, and what are the ways around it?
3. Why can adding more worker processes make throughput worse?
4. Why is a slow login endpoint acceptable (even desirable)?
5. Open vs closed workload models (arrival-rate vs fixed users): which hides overload, and why?
6. What does "dropped iterations" in k6 tell you?
