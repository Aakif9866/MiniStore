# Phase 8 — Observability

## BEFORE

### 1. Logs vs metrics vs traces

| | Answers | Shape | Cost | Tool here |
|---|---|---|---|---|
| **Logs** | "What happened to *this* request?" | one event per line, any detail | grows with traffic | pino (JSON lines) |
| **Metrics** | "How is the system doing *overall*?" | numbers aggregated over time | fixed per series | Prometheus |
| **Traces** | "Where did *this* request spend its time across services?" | tree of timed spans | sampled | not yet (see below) |

You alert on **metrics** (cheap, aggregated), then use **logs** to find the specific requests.
The **request id** joins the two: it's on every log line and returned to the client.

### 2. RED metrics and percentiles

For every request-serving component: **R**ate (requests/s), **E**rrors (failed/s), **D**uration.

Averages hide pain. If 99 requests take 10 ms and one takes 5 s, the average is 60 ms and looks fine.
**p95/p99** = "95%/99% of requests were faster than this". p99 is what your unluckiest regular users see.
Prometheus **histograms** count requests into duration buckets; `histogram_quantile` estimates
percentiles from those buckets, and they can be summed across instances (averages of percentiles can't).

### 3. The cardinality trap

Every unique label combination is a separate time series. Labelling by URL (`/files/3f2a…`) makes one
series per file → millions → Prometheus runs out of memory. Label by **route pattern** (`/files/:id`).

### 4. Liveness vs readiness

| | `/health` (liveness) | `/ready` (readiness) |
|---|---|---|
| Question | Is the process alive? | Can it serve requests right now? |
| Checks | nothing | Postgres `SELECT 1` + MinIO `HeadBucket`, 2 s timeout |
| If failing | restart the process | stop sending traffic; a restart won't fix the database |

Phase 2 found that `/health` returned 200 with Postgres down. `/ready` is the fix.

---

## AFTER

### Files

```
backend/src/observability.ts   pino logger, prom-client registry + metrics, requestObserver, metrics app
backend/src/storage.ts         SDK middleware times every S3 call
backend/src/app.ts             /ready; records each router's mount path for route labels
backend/src/server.ts          metrics server on 127.0.0.1:9464
infra/prometheus/              scrape config + 6 alert rules
infra/grafana/                 datasource + dashboard, provisioned automatically
docker-compose.yml             prometheus, grafana (profile "observability"); MinIO metrics enabled
```

### Run it

```bash
docker compose --profile observability up -d
cd backend && npm run dev            # logs pretty-printed by pino-pretty
```

| | URL |
|---|---|
| Grafana dashboard "MiniStore — API & Storage" | http://127.0.0.1:3001 (admin / `GRAFANA_ADMIN_PASSWORD`) |
| Prometheus (queries, targets, alerts) | http://127.0.0.1:9090 |
| Raw API metrics | http://127.0.0.1:9464/metrics |

### Metrics exported

| Metric | Type | Labels | Use |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | method, route, status_code | all of RED |
| `ministore_s3_request_duration_seconds` | histogram | operation, outcome | is MinIO the slow part? |
| `ministore_uploaded_bytes_total` | counter | — | upload throughput |
| `ministore_lifecycle_items_total` | counter | task | what the cleanup job did; dangling rows alert |
| Node defaults | various | — | memory, heap, GC, **event-loop lag** (CPU saturation) |
| MinIO `minio_cluster_*` | various | — | stored bytes, objects, capacity |

### Dashboard

Four headline numbers (requests/s, server-error %, p95 of non-upload requests, bytes in MinIO), then
rate by route, errors by status, p50/p95/p99, MinIO latency per operation, upload throughput, process
memory, event-loop lag, and the lifecycle job.

### Alerts (visible at `/alerts`; no Alertmanager locally)

`ApiDown`, `MinioDown`, `HighErrorRate` (>5% 5xx for 5 min), `SlowRequests` (p95 > 1 s, uploads
excluded), `S3Errors`, `DanglingRows` (possible data loss → check backups).

### Verified end to end

After 60 real requests: both scrape targets **up**; Prometheus had
`/files/upload 201 ×20`, `/files 200 ×20`, `/files/* 401 ×20`; MinIO reported 3.3 MB stored; all six
rules loaded as `ok`; Grafana listed the provisioned dashboard.

### Bugs found while building

| Symptom | Cause | Fix |
|---|---|---|
| A 404 on `/files/:id` would be labelled `/:id` | Express resets `req.baseUrl` when an error leaves a router | `app.ts` stores each router's mount path in `res.locals` |
| 401s before any route matched had no useful label | No route was matched yet | label `/files/*` instead of `unmatched` |
| Dashboard "Bytes in MinIO" empty | Per-bucket metrics live at `/minio/v2/metrics/bucket` | use `minio_cluster_usage_total_bytes` |

### Security decisions

- **Metrics on a separate port bound to 127.0.0.1**, not on the API port: they reveal routes, error rates
  and memory.
- **Request ids from clients are accepted only if they match `[\w-]{1,64}`**; anything else is replaced, so
  a header can't forge log fields or bloat logs.
- **Logger redacts** `authorization` and `cookie` headers.
- MinIO metrics are public **only because the port is localhost-only**; production uses a scrape token.

### What the tests prove (83 passing, +7)

Request ids generated, kept when sane, replaced when unsafe; metrics labelled `/files/:id` and `/files/*`
with the raw id absent; S3 `PutObjectCommand` timed; uploaded-bytes counter exact; `/ready` 200 when
healthy and 503 with the failing dependency named while `/health` stays 200.

### Not done: tracing

With one service, request id + logs + S3 timing covers what tracing would show. With several services,
add OpenTelemetry (auto-instruments Express, `pg` and the AWS SDK) and send spans to Grafana Tempo or Jaeger.

### Interview questions

1. Logs, metrics, traces: what does each answer, and which do you alert on?
2. What are RED metrics? What are USE metrics, and when would you use those instead?
3. Why is p99 more useful than the average? How does Prometheus compute it from a histogram?
4. Why can you sum histograms across instances but not average their p95s?
5. What is label cardinality and how can it take down Prometheus?
6. Liveness vs readiness: what does each do in Kubernetes when it fails?
7. Why shouldn't `/metrics` be on the public port?
8. A user reports "upload failed at 3:02 pm". How do you find what happened?
