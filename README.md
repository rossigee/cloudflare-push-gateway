# Cloudflare Push Gateway

A Cloudflare Workers-based [Prometheus Pushgateway](https://prometheus.io/docs/instrumenting/pushing/)-compatible service. Stores pushed metrics in a Durable Object, making them available for Prometheus to scrape.

## Features

- API-compatible with Prometheus Pushgateway (PUT/POST/GET/DELETE)
- Custom web UI at `/` for browsing and deleting metrics
- Durable Object storage for persistence and strong consistency
- Optional basic authentication
- Prometheus `/api/v1/targets` endpoint

## Quick Start

```bash
npm install
npm run dev
```

Starts a local dev server (default port 8787).

### Pushing Metrics

```bash
# Push metrics for a job/instance
curl -X PUT --data-binary 'my_metric 42' \
  http://localhost:8787/metrics/job/my_job/instance/my_instance

# Push with existing labels (grouping labels are added automatically)
curl -X PUT --data-binary 'http_requests_total{method="GET"} 100' \
  http://localhost:8787/metrics/job/my_job/instance/my_instance

# Push without instance label
curl -X PUT --data-binary 'uptime_seconds 3600' \
  http://localhost:8787/metrics/job/my_job

# Push with arbitrary grouping labels
curl -X PUT --data-binary 'latency_seconds 0.05' \
  http://localhost:8787/metrics/job/my_job/region/us-east1/instance/srv1
```

### Retrieving Metrics

```bash
# Get all metrics (Prometheus scrape endpoint)
curl http://localhost:8787/metrics

# Get metrics for a specific job
curl http://localhost:8787/metrics/job/my_job

# Get metrics for a specific instance
curl http://localhost:8787/metrics/job/my_job/instance/my_instance
```

### Deleting Metrics

```bash
# Delete a specific instance
curl -X DELETE http://localhost:8787/metrics/job/my_job/instance/my_instance

# Delete all instances for a job
curl -X DELETE http://localhost:8787/metrics/job/my_job
```

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/metrics/job/<job>[/<label>/<value>...]` | Push/replace metrics for a grouping |
| `POST` | `/metrics/job/<job>[/<label>/<value>...]` | Same as PUT (replaces metrics) |
| `GET` | `/metrics/job/<job>[/<label>/<value>...]` | Get metrics for a grouping |
| `DELETE` | `/metrics/job/<job>[/<label>/<value>...]` | Delete metrics for a grouping |
| `GET` | `/metrics` | Get all metrics across all jobs |
| `GET` | `/` | Web UI |
| `GET` | `/health` | Health check (JSON) |
| `GET` | `/api/v1/targets` | List all targets (JSON) |

### Response Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `404` | Grouping not found (on GET) |
| `401` | Unauthorized (if auth is configured) |
| `405` | Method not allowed |

### Grouping Labels

Grouping labels organize metrics and the URL path defines them:

```
/metrics/job/<job>[/<label_name>/<label_value>]...
```

The first label is always `job`. Additional labels like `instance` or `region` are appended as alternating name/value path segments.

Metrics stored under `/metrics/job/my_job/instance/srv1` produce:
```
# When Prometheus scrapes, labels look like:
cpu_usage{job="my_job", instance="srv1"} 0.85
```

### Response Format

All metric responses use Content-Type `text/plain; version=0.0.4` (Prometheus text format). The `/health` and `/api/v1/targets` endpoints return JSON.

## Authentication

Authentication is optional. When any auth method is configured, all endpoints (except the web UI at `/`) require valid credentials. Three methods are supported, checked in order:

### 1. Basic Auth (Legacy)

Username/password via `Authorization: Basic <base64>` header.

For local dev, add to `wrangler.toml` `[vars]`:

```toml
[vars]
PUSHGATEWAY_AUTH_USER = "admin"
PUSHGATEWAY_AUTH_PASS = "your-secure-password"
```

For production, use Cloudflare Secrets:

```bash
npx wrangler secret put PUSHGATEWAY_AUTH_USER
npx wrangler secret put PUSHGATEWAY_AUTH_PASS
```

Usage:

```bash
curl -u admin:your-secure-password https://push.golder.tech/metrics
```

### 2. JWT/OIDC (Users)

Bearer tokens validated against an OIDC provider's JWKS endpoint.

Set these secrets (or `[vars]` for dev):

```bash
npx wrangler secret put JWT_ISSUER
npx wrangler secret put JWT_AUDIENCE
```

- `JWT_ISSUER` — OIDC issuer URL (e.g. `https://accounts.google.com`)
- `JWT_AUDIENCE` — Expected `aud` claim (your OIDC client ID)
- `JWKS_URI` — Optional, defaults to `{issuer}/.well-known/jwks.json`

Usage:

```bash
curl -H "Authorization: Bearer <jwt_token>" https://push.golder.tech/metrics
```

### 3. API Tokens (Consumer Apps)

Static tokens for service-to-service auth. Can be sent as `Bearer <token>` or `X-API-Key: <token>`.

Set as a comma-separated list:

```bash
npx wrangler secret put API_TOKENS
```

Example value: `tok1,tok2,tok3`

Usage:

```bash
# Bearer header
curl -H "Authorization: Bearer tok1" https://push.golder.tech/metrics

# X-API-Key header
curl -H "X-API-Key: tok1" https://push.golder.tech/metrics
```

### Auth Flow

```
Request
  ├─ Authorization: Bearer <token>  → try JWT → fail? → try API tokens → fail? → 401
  ├─ Authorization: Basic <creds>   → check user/pass → fail? → 401
  ├─ X-API-Key: <token>             → check API tokens → fail? → 401
  └─ none                           → 401 (unless no auth configured at all)
```

## Prometheus Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'pushgateway'
    honor_labels: true
    metrics_path: /metrics
    static_configs:
      - targets:
          - 'your-worker.your-subdomain.workers.dev'
```

The `honor_labels: true` setting preserves the `job` and `instance` labels from the pushed metrics instead of overwriting them.

## Deployment

### 1. Create an API Token

Go to https://dash.cloudflare.com/profile/api-tokens and click **Create Token**, then select **Edit Cloudflare Workers** template. Remove any permissions you don't need (KV, R2, Tail, etc.).

The only required permission is:

| Category | Permission | Access |
|----------|-----------|--------|
| Account | Workers Scripts | Edit |

This covers Workers, Durable Objects, and migrations. No Zone or other Account permissions are needed.

**Important for account-owned tokens (`cfat_` prefix)**: you must set `account_id` in `wrangler.toml` or `CLOUDFLARE_ACCOUNT_ID` in `.env` — account tokens can't auto-resolve the account via the `/memberships` endpoint.

Set **Account Resources** to your specific account (or *All accounts*).

### 2. Set Up Credentials

Copy the template and fill in your token and account ID:

```bash
cp .env.template .env
```

Edit `.env`:

```
CLOUDFLARE_API_TOKEN=cfat_your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_hex
```

`.env` is gitignored. To find your Account ID, go to the Cloudflare dashboard URL — it's the hex string in the address bar after `https://dash.cloudflare.com/`.

### 3. Deploy

```bash
source .env && npm run deploy
```

This runs `wrangler deploy --env ""` which deploys to the `default` environment (no named environment).

### Accessing the Worker

#### workers.dev Subdomain

If your account has workers.dev enabled, the worker is accessible at:

```
https://cloudflare-push-gateway.<your-subdomain>.workers.dev
```

If you see `wrangler subdomain` errors, enable a workers.dev subdomain first:

```bash
npx wrangler subdomain <your-prefix>
```

This creates `https://<your-prefix>.workers.dev` — all workers live under this.

#### Custom Domain (Optional)

Add a route to `wrangler.toml` and re-deploy:

```toml
routes = [
  { pattern = "pushgateway.example.com", custom_domain = true }
]
```

Or use a zone route:

```toml
routes = [
  { pattern = "pushgateway.example.com/*", zone_id = "<your-zone-id>" }
]
```

### Production Checklist

1. Set `PUSHGATEWAY_AUTH_USER` and `PUSHGATEWAY_AUTH_PASS` as secrets:
   ```bash
   npx wrangler secret put PUSHGATEWAY_AUTH_USER
   npx wrangler secret put PUSHGATEWAY_AUTH_PASS
   ```
   (Do not use `wrangler.toml` `[vars]` for secrets — they're visible in the dashboard.)
2. ✓ Body size limit is enforced (10MB via `MAX_BODY_SIZE`)
3. Consider rate limiting or IP restrictions via Cloudflare WAF
4. Update `compatibility_date` in `wrangler.toml` periodically

## CI/CD

The repo includes a GitHub Actions workflow at `.github/workflows/ci.yml`:

1. **Test job**: checks out code, installs deps, runs `typecheck` and `test`
2. **Deploy job** (main only): runs after tests pass, deploys with `wrangler deploy`

To enable GitHub Actions deployment, add this repository secret:

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and Durable Objects: Edit |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLOUDFLARE_API_TOKEN` | For deploy | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | For deploy | Cloudflare Account ID (optional if derivable from token) |
| `PUSHGATEWAY_AUTH_USER` | No | Username for basic auth |
| `PUSHGATEWAY_AUTH_PASS` | No | Password for basic auth |
| `JWT_ISSUER` | No | OIDC issuer URL for JWT auth |
| `JWT_AUDIENCE` | No | Expected JWT `aud` claim |
| `JWKS_URI` | No | JWKS endpoint (defaults to `{issuer}/.well-known/jwks.json`) |
| `API_TOKENS` | No | Comma-separated API tokens for service auth |

## Development

```bash
npm install       # Install dependencies
npm run dev       # Start local dev server
npm test          # Run 26 tests (21 pass, 5 conditional auth tests skip by default)
npm run typecheck # TypeScript type checking
```

### Testing

Tests use [vitest](https://vitest.dev/) with the [Cloudflare Workers pool](https://developers.cloudflare.com/workers/testing/vitest-integration/). All tests run locally against Miniflare -- no remote resources needed.

- 16 core API tests: push, get, delete, health, UI
- 2 edge case tests: HELP/TYPE line preservation, special characters in names
- 1 empty body test
- 2 `/api/v1/targets` tests
- 5 auth tests (3 API token, 2 basic auth — all skipped unless auth credentials are configured)

To run auth tests locally, add auth credentials to `.env` (`.env` is gitignored):

```
PUSHGATEWAY_AUTH_USER=testuser
PUSHGATEWAY_AUTH_PASS=testpass
API_TOKENS=test-api-token
```

### Configuration

The `wrangler.toml` defines the Durable Object binding and deployment settings:

```toml
name = "cloudflare-push-gateway"
compatibility_date = "2025-04-01"
main = "src/index.ts"

[[durable_objects.bindings]]
name = "METRICS_STORE"
class_name = "MetricsStore"

[[migrations]]
tag = "v1"
new_classes = ["MetricsStore"]
```

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌─────────────────────┐
│  Prometheus  │    │  Push Client  │    │   Web Browser (UI)  │
│  (scraper)   │    │  (curl, app)  │    │                     │
└──────┬───────┘    └──────┬───────┘    └──────────┬──────────┘
       │                  │                        │
       ▼                  ▼                        ▼
┌────────────────────────────────────────────────────────────────────┐
│           Cloudflare Worker (src/index.ts + src/auth.ts)           │
│  - API routing / URL parsing                                       │
│  - Auth (Basic, JWT/OIDC, API tokens)                              │
│  - UI rendering (HTML)                                             │
│  - Forwards storage ops to Durable Object                          │
└──────────────────────────┬─────────────────────────────────────────┘
                       │ internal fetch
                       ▼
┌──────────────────────────────────────────────────────────┐
│          Durable Object: MetricsStore                    │
│          (src/durable-object.ts)                         │
│  - Stores content + timestamps per grouping key          │
│  - Single Durable Object instance for all metrics        │
│  - Storage keys: `<job>\t<label>\0<value>...`            │
│  - Content stored as plain string (Prometheus text)      │
└──────────────────────────────────────────────────────────┘
```

### Internal API

The Worker communicates with the Durable Object via internal fetch URLs:

| Path | Method | Purpose |
|------|--------|---------|
| `/put/<job>[/<label>/<value>...]` | PUT | Store metrics |
| `/get/<job>[/<label>/<value>...]` | GET | Retrieve specific grouping |
| `/delete/<job>[/<label>/<value>...]` | DELETE | Remove specific grouping |
| `/list` | GET | All metrics (aggregated) |
| `/list/<job>` | GET | All instances for a job |
| `/list-structured` | GET | JSON with all metrics + timestamps |
| `/drop/<job>` | DELETE | Remove all instances for a job |

## Project Structure

```
src/
  index.ts            # Worker entry point (API routing, UI)
  durable-object.ts   # MetricsStore Durable Object (storage, label injection)
  auth.ts             # Authentication (Basic, JWT/OIDC, API tokens)
  tests/
    pushgateway.test.ts # API integration tests (26 tests)
wrangler.toml         # Cloudflare Workers configuration
vitest.config.ts      # Test framework configuration
tsconfig.json         # TypeScript configuration
package.json          # Dependencies and scripts
```

## License

MIT
