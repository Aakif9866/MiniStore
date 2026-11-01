// k6 load test for MiniStore. Pick a scenario with -e SCENARIO=read|login|upload|mixed.
//   docker compose run --rm k6 run -e SCENARIO=read /scripts/ministore.js
// Start the API with AUTH_RATE_LIMIT raised first, or setup() itself gets rate-limited (see docs/09).
import { check } from "k6";
import { randomBytes } from "k6/crypto";
import http from "k6/http";

const BASE = __ENV.BASE || "http://host.docker.internal:3000";
const SCENARIO = __ENV.SCENARIO || "read";
const USERS = 10;
const PASSWORD = "load-test-password";
const JSON_HEADERS = { "Content-Type": "application/json" };

const scenarios = {
  // Read path: list files + mint a presigned URL. Ramps until something gives.
  read: {
    executor: "ramping-arrival-rate", exec: "read", timeUnit: "1s", startRate: 50,
    preAllocatedVUs: 100, maxVUs: 1000,
    // -e PEAK=4000 to push further once a bottleneck is fixed.
    stages: [{ target: 300, duration: "20s" }, { target: Number(__ENV.PEAK || 1500), duration: "40s" }, { target: Number(__ENV.PEAK || 1500), duration: "20s" }],
  },
  // Login: scrypt is deliberately expensive, so expect a low ceiling.
  login: {
    executor: "ramping-arrival-rate", exec: "login", timeUnit: "1s", startRate: 5,
    preAllocatedVUs: 50, maxVUs: 400,
    stages: [{ target: 150, duration: "60s" }, { target: 150, duration: "20s" }],
  },
  // Fixed rate of reads, for profiling or before/after comparisons: -e RATE=400 -e DURATION=20s
  steady: {
    executor: "constant-arrival-rate", exec: "read", timeUnit: "1s",
    rate: Number(__ENV.RATE || 300), duration: __ENV.DURATION || "30s", preAllocatedVUs: 100, maxVUs: 500,
  },
  // Uploads of 1 MiB, then permanent delete so the test doesn't fill the disk.
  upload: { executor: "constant-vus", exec: "upload", vus: 20, duration: "60s" },
};
// Mixed: what a real day might look like, run all at once at fixed rates.
const mixed = {
  readers: { executor: "constant-arrival-rate", exec: "read", rate: 200, timeUnit: "1s", duration: "60s", preAllocatedVUs: 100, maxVUs: 400 },
  uploaders: { executor: "constant-arrival-rate", exec: "upload", rate: 10, timeUnit: "1s", duration: "60s", preAllocatedVUs: 20, maxVUs: 100 },
  logins: { executor: "constant-arrival-rate", exec: "login", rate: 5, timeUnit: "1s", duration: "60s", preAllocatedVUs: 10, maxVUs: 100 },
};

export const options = {
  scenarios: SCENARIO === "mixed" ? mixed : { [SCENARIO]: scenarios[SCENARIO] },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<300"],
    "http_req_duration{kind:login}": ["p(95)<1000"],
    "http_req_duration{kind:upload}": ["p(95)<2000"],
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

const auth = (token, kind) => ({ headers: { Authorization: `Bearer ${token}` }, tags: { kind } });
const userFor = (data) => data.users[__VU % USERS];

export function setup() {
  const run = Date.now();
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const email = `load-${run}-${i}@test.dev`;
    http.post(`${BASE}/auth/register`, JSON.stringify({ email, password: PASSWORD }), { headers: JSON_HEADERS });
    const token = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: JSON_HEADERS }).json("token");
    if (!token) throw new Error("setup: login failed — is AUTH_RATE_LIMIT raised?");
    for (let j = 0; j < 5; j++) {
      http.post(`${BASE}/files/upload`, { file: http.file(randomBytes(10 * 1024), `seed-${j}.bin`) }, auth(token, "seed"));
    }
    users.push({ email, token });
  }
  return { users };
}

export function read(data) {
  const { token } = userFor(data);
  const list = http.get(`${BASE}/files`, auth(token, "read"));
  check(list, { "list 200": (r) => r.status === 200 });
  const first = list.status === 200 ? list.json()[0] : null;
  if (first) {
    const url = http.get(`${BASE}/files/${first.id}/download-url`, auth(token, "read"));
    check(url, { "url 200": (r) => r.status === 200 });
  }
}

export function login(data) {
  const { email } = userFor(data);
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: JSON_HEADERS,
    tags: { kind: "login" },
  });
  check(res, { "login 200": (r) => r.status === 200 });
}

const ONE_MIB = randomBytes(1024 * 1024);
export function upload(data) {
  const { token } = userFor(data);
  const res = http.post(`${BASE}/files/upload`, { file: http.file(ONE_MIB, "load.bin") }, auth(token, "upload"));
  check(res, { "upload 201": (r) => r.status === 201 });
  if (res.status === 201) {
    const id = res.json("id");
    http.del(`${BASE}/files/${id}`, null, auth(token, "cleanup"));
    http.del(`${BASE}/files/trash/${id}`, null, auth(token, "cleanup"));
  }
}

// Leave nothing behind: every user's files go to the trash, then the trash is emptied.
export function teardown(data) {
  for (const { token } of data.users) {
    for (const f of http.get(`${BASE}/files`, auth(token, "cleanup")).json() || []) {
      http.del(`${BASE}/files/${f.id}`, null, auth(token, "cleanup"));
    }
    http.del(`${BASE}/files/trash`, null, auth(token, "cleanup"));
  }
}
