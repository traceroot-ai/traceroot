# Threat Model — TraceRoot

> **Framework:** STRIDE + 4-question model
> **Surfaces covered:** SaaS (app.traceroot.ai), Self-hosted, Python SDK
> **Status:** Initial draft — open for review
> **References:** [SECURITY.md](./SECURITY.md) · [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) · [OWASP Threat Modeling](https://owasp.org/www-community/Threat_Modeling)

---

## 1. What Are We Building?

TraceRoot is an open-source observability and self-healing platform for AI agents. It captures LLM traces, filters signal from noise, and enables AI-assisted root cause analysis by connecting to a sandbox with production source code and GitHub history.

### System Components

| Component | Technology | Description |
|---|---|---|
| **Browser client** | Next.js (TypeScript) | Web UI — trace explorer, debugger, onboarding |
| **REST API** | FastAPI (Python) | Core backend — auth, trace ingestion, agent runner |
| **Celery worker** | Python / Redis | Async task queue — processes traces, runs AI debugging |
| **ClickHouse** | ClickHouse DB | Columnar store for traces and spans |
| **Redis** | Redis | Task queue broker + short-lived caching |
| **Object storage** | AWS S3 | Trace payload storage for large spans |
| **Python SDK** | `traceroot` PyPI package | Installed in user's agent; instruments LLM calls via OpenTelemetry |
| **Daytona sandbox** | Containerised runtime | Isolated environment for AI agentic debugging with access to user source code |
| **GitHub integration** | GitHub OAuth + API | Reads commits, PRs, issues for root cause correlation |

### Deployment Surfaces

- **SaaS** (`app.traceroot.ai`): Anthropic-hosted, multi-tenant. Users authenticate via GitHub OAuth.
- **Self-hosted (Docker)**: Single-tenant. User runs the full stack locally or on their own cloud.
- **Self-hosted (Kubernetes / Terraform)**: Production-grade deploy on AWS with Helm charts.
- **SDK only**: User installs the Python SDK and points it at either SaaS or their own host.

### Trust Boundaries

```
[ User's AI Agent Process ]
        |  SDK (OTLP/HTTP)
        v
[ TraceRoot Ingestion API ]  <-- trust boundary: API key required
        |
        v
[ ClickHouse + S3 ]          <-- trust boundary: internal network only
        |
        v
[ Celery Worker ]
        |  sandbox API
        v
[ Daytona Sandbox ]          <-- trust boundary: ephemeral container, no persistent state
        |  GitHub API
        v
[ User's GitHub Repo ]       <-- trust boundary: OAuth token scope
```

---

## 2. What Can Go Wrong?

Threats are categorised using **STRIDE**. Each threat maps to a component and a priority level (P0 = critical, P1 = high, P2 = medium, P3 = low).

### 2.1 Spoofing

| ID | Threat | Component | Priority |
|---|---|---|---|
| S-01 | Attacker uses a stolen `TRACEROOT_API_KEY` to ingest fake traces or read another tenant's data | REST API | P0 |
| S-02 | Attacker forges a GitHub OAuth callback to hijack a user's session | Browser client / FastAPI | P1 |
| S-03 | Malicious SDK version published to PyPI impersonates the official `traceroot` package (typosquatting) | PyPI / SDK | P1 |
| S-04 | In self-hosted mode, internal services (Redis, ClickHouse) accept connections without authentication if misconfigured | Self-hosted infra | P2 |

### 2.2 Tampering

| ID | Threat | Component | Priority |
|---|---|---|---|
| T-01 | Trace payloads modified in transit between SDK and ingestion API (MITM on HTTP, not HTTPS) | SDK → API | P1 |
| T-02 | Attacker with write access to ClickHouse modifies historical trace records to obscure a past failure | ClickHouse | P1 |
| T-03 | Malicious OSS contributor introduces backdoor in the `traceroot` PyPI package during a supply-chain attack | SDK / CI | P0 |
| T-04 | Prompt injection via crafted trace payloads manipulates the AI debugger's reasoning or output | Celery worker / AI debugger | P1 |

### 2.3 Repudiation

| ID | Threat | Component | Priority |
|---|---|---|---|
| R-01 | No audit log of which user triggered an AI debugging session or accessed a trace | REST API / ClickHouse | P2 |
| R-02 | Self-hosted deployments have no centralised log aggregation, making post-incident forensics difficult | Self-hosted infra | P2 |

### 2.4 Information Disclosure

| ID | Threat | Component | Priority |
|---|---|---|---|
| I-01 | LLM provider API keys (OpenAI, Anthropic, etc.) captured in trace payloads and stored unmasked | SDK / ClickHouse / S3 | P0 |
| I-02 | GitHub OAuth tokens stored or logged in plaintext | FastAPI / logs | P0 |
| I-03 | Trace payloads contain PII (user queries, agent outputs) accessible cross-tenant in SaaS | ClickHouse (multi-tenant) | P0 |
| I-04 | Stripe billing data exposed via API endpoint lacking authorisation check | REST API | P1 |
| I-05 | Source code copied into Daytona sandbox persists after session and is accessible to other jobs | Daytona sandbox | P1 |
| I-06 | Verbose error messages in API responses reveal internal stack traces or DB schema | REST API | P2 |
| I-07 | ClickHouse credentials or S3 credentials leak through environment variables in Docker logs | Self-hosted infra | P2 |

### 2.5 Denial of Service

| ID | Threat | Component | Priority |
|---|---|---|---|
| D-01 | Attacker floods trace ingestion endpoint with high-volume spans, exhausting ClickHouse write capacity | REST API / ClickHouse | P1 |
| D-02 | Celery worker queue overwhelmed with AI debugging tasks, starving real-time trace processing | Redis / Celery | P1 |
| D-03 | Large trace payloads (>300 spans) cause memory exhaustion in the Daytona sandbox (known issue #618) | Daytona sandbox | P2 |
| D-04 | Recursive or deeply nested agent traces cause unbounded processing time | Celery worker | P2 |

### 2.6 Elevation of Privilege

| ID | Threat | Component | Priority |
|---|---|---|---|
| E-01 | Regular user accesses another tenant's traces by guessing or enumerating trace IDs (IDOR) | REST API / ClickHouse | P0 |
| E-02 | Prompt injection in trace data causes the AI debugger to execute arbitrary commands in the Daytona sandbox | Daytona sandbox | P0 |
| E-03 | Compromised GitHub OAuth token used to access private repos beyond the original scope granted | GitHub integration | P1 |
| E-04 | Self-hosted Redis instance without AUTH allows any process on the network to enqueue arbitrary Celery tasks | Self-hosted infra / Redis | P1 |

---

## 3. What Do We Do About It?

### 3.1 Mitigations Already in Place

| Threat ID(s) | Mitigation |
|---|---|
| S-01 | API key authentication required on all ingestion endpoints |
| S-02 | GitHub OAuth with state parameter; session tokens stored server-side |
| T-01, I-01–02 | HTTPS enforced on SaaS; SDK defaults to HTTPS for `TRACEROOT_HOST_URL` |
| T-03 | PyPI package published from CI; contributors sign CLA |
| I-01 | Sensitive fields (API keys) noted in SECURITY.md as "encrypted at rest" |
| I-03 | Tenant isolation by `project_id` in ClickHouse queries |
| E-02 | Daytona sandbox is ephemeral and containerised, limiting blast radius |

### 3.2 Known Gaps and Recommended Actions

| Threat ID | Gap | Recommended Action | Priority |
|---|---|---|---|
| T-03, T-04 | No GitHub Actions pinning — workflows use floating tags (e.g. `@v3`) | Pin all GitHub Actions to commit SHAs (see issue #762) | P1 |
| T-04 | No systematic sanitisation of trace payloads before they reach the AI prompt | Add a payload sanitisation layer in the Celery worker before AI prompt construction | P0 |
| I-01 | No automatic scrubbing of API key patterns in span attributes | Implement regex-based secret scrubbing in the SDK before payloads are sent | P0 |
| I-03 | Row-level security in ClickHouse not formally verified | Audit all ClickHouse queries for tenant isolation; add integration tests asserting cross-tenant data is unreachable | P0 |
| R-01 | No audit log table for sensitive operations (debug session start, trace delete, billing change) | Add `audit_log` table in ClickHouse; log actor, action, resource, timestamp | P1 |
| D-01 | No rate limiting on trace ingestion endpoint | Implement per-API-key rate limiting at the FastAPI layer (e.g. `slowapi`) | P1 |
| D-03 | Large traces (>300 spans) crash Daytona sandbox (issue #618) | Add span count limit before sandbox download; chunk or summarise large traces | P2 |
| E-01 | IDOR risk on trace/span endpoints if tenant check is missing | Audit every GET/DELETE endpoint for explicit `project_id` ownership check | P0 |
| E-04 | Self-hosted Redis has no AUTH by default in `docker-compose.yml` | Set `requirepass` in Redis config and document in self-hosting guide | P1 |
| S-04 | Self-hosted ClickHouse may accept unauthenticated connections | Enforce ClickHouse user/password in `docker-compose.yml` defaults | P2 |

---

## 4. Did We Do a Good Job?

Use this checklist when reviewing a PR or doing a quarterly security review.

### Authentication & Authorisation
- [ ] Every API endpoint has an explicit authentication check
- [ ] Every API endpoint that accesses tenant data has an explicit `project_id` ownership check
- [ ] GitHub OAuth state parameter is validated on callback
- [ ] Redis and ClickHouse require credentials in all deployment modes

### Data Handling
- [ ] No LLM provider API keys or GitHub tokens stored or logged in plaintext
- [ ] Trace payloads are scrubbed for secrets before storage and before AI prompt injection
- [ ] PII in trace data is scoped to the owning tenant and cannot be accessed cross-tenant
- [ ] S3 bucket policies restrict access to internal services only

### Supply Chain
- [ ] All GitHub Actions workflows pin dependencies to commit SHAs
- [ ] PyPI releases are built and published exclusively from CI
- [ ] Contributors agree to the CLA before merge

### Sandboxing
- [ ] Daytona sandbox is ephemeral — no state persists between sessions
- [ ] User source code is deleted from the sandbox after session ends
- [ ] AI prompt construction sanitises trace payloads to prevent prompt injection

### Resilience
- [ ] Rate limiting is active on trace ingestion and AI debugging endpoints
- [ ] Celery task queue has a maximum queue depth configured
- [ ] Large trace payloads are handled gracefully (chunked or rejected with a clear error)

### Audit & Forensics
- [ ] Sensitive operations are written to an audit log with actor, action, resource, timestamp
- [ ] Self-hosted deployments document how to enable log aggregation

---

## Appendix: Data Assets at Risk

| Data Asset | Location | Sensitivity |
|---|---|---|
| LLM provider API keys (OpenAI, Anthropic, Gemini, etc.) | SDK env → trace payloads → ClickHouse | Critical |
| GitHub OAuth tokens | FastAPI session / DB | Critical |
| Agent trace payloads (may contain PII, business logic) | ClickHouse + S3 | High |
| Stripe billing / subscription data | Backend DB | High |
| Session tokens | Browser cookies / server | High |
| ClickHouse / Redis / S3 credentials | Environment variables / Docker | High |
| Source code (in Daytona sandbox) | Ephemeral container | Medium |
| GitHub commits, PRs, issues | GitHub API (read-only) | Medium |

---

## Appendix: Threat Actors

| Actor | Goal | Capability |
|---|---|---|
| External attacker | Steal API keys or trace data; pivot to user's AI systems | Unauthenticated network access |
| Malicious OSS contributor | Backdoor the SDK or CI pipeline | Write access to PRs |
| Compromised dependency | Introduce vulnerable code via a dependency update | Indirect code execution |
| Malicious tenant (SaaS) | Access another tenant's traces or exhaust shared resources | Valid API key, crafted payloads |
| Insider / rogue employee | Exfiltrate customer data or sabotage infrastructure | Internal network and DB access |

---

*This document should be reviewed and updated whenever a new component is added, a significant architectural change is made, or a security incident occurs. Ping `founders@traceroot.ai` or open a PR.*
