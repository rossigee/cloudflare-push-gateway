import { MetricsStore, Env, MetricEntry, MAX_BODY_SIZE } from './durable-object';
import { authenticate, unauthorized } from './auth';

export { MetricsStore };

const VERSION = '0.1.1';

function getStore(env: Env): DurableObjectStub<MetricsStore> {
  const id = env.METRICS_STORE.idFromName('pushgateway');
  return env.METRICS_STORE.get(id);
}

function encodeLabelParts(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `/${encodeURIComponent(k)}/${encodeURIComponent(v)}`)
    .join('');
}

function parseMetricsPath(path: string): { job: string; additionalLabels: Record<string, string> } | null {
  const match = path.match(/^\/metrics\/job\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const job = decodeURIComponent(match[1]);
  const rest = match[2] || '';
  const parts = rest.split('/').filter(p => p.length > 0);
  const additionalLabels: Record<string, string> = {};
  if (parts.length % 2 !== 0) return null;
  for (let i = 0; i < parts.length; i += 2) {
    additionalLabels[decodeURIComponent(parts[i])] = decodeURIComponent(parts[i + 1]);
  }
  return { job, additionalLabels };
}

async function handleMetricsAll(env: Env): Promise<Response> {
  const store = getStore(env);
  return store.fetch('http://do/list');
}

async function handleMetricsJob(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const parsed = parseMetricsPath(url.pathname);
  if (!parsed) return new Response('Invalid path', { status: 400 });

  const store = getStore(env);
  const { job, additionalLabels } = parsed;
  const encLabels = encodeLabelParts(additionalLabels);

  switch (method) {
    case 'GET': {
      if (Object.keys(additionalLabels).length === 0) {
        return store.fetch(`http://do/list/${encodeURIComponent(job)}`);
      }
      const resp = await store.fetch(`http://do/get/${encodeURIComponent(job)}${encLabels}`);
      if (resp.status === 404) return new Response('', { status: 404 });
      return resp;
    }
    case 'PUT':
    case 'POST': {
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return new Response('Request body too large', { status: 413 });
      }
      const body = await request.text();
      if (body.length > MAX_BODY_SIZE) {
        return new Response('Request body too large', { status: 413 });
      }
      return store.fetch(new Request(
        `http://do/put/${encodeURIComponent(job)}${encLabels}`,
        { method: 'PUT', body }
      ));
    }
    case 'DELETE': {
      if (Object.keys(additionalLabels).length === 0) {
        return store.fetch(new Request(
          `http://do/drop/${encodeURIComponent(job)}`,
          { method: 'DELETE' }
        ));
      }
      return store.fetch(new Request(
        `http://do/delete/${encodeURIComponent(job)}${encLabels}`,
        { method: 'DELETE' }
      ));
    }
    default:
      return new Response('Method Not Allowed', { status: 405 });
  }
}

async function handleApiV1Targets(env: Env): Promise<Response> {
  const store = getStore(env);
  const resp = await store.fetch('http://do/list-structured');
  const metrics: MetricEntry[] = await resp.json();

  const targets = metrics.map(m => ({
    labels: { job: m.job, ...m.labels },
    health: 'up' as const,
    lastPush: m.updatedAt ? new Date(m.updatedAt).toISOString() : '',
  }));

  return Response.json({ status: 'success', data: targets });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleUI(env: Env): Promise<Response> {
  const store = getStore(env);
  const resp = await store.fetch('http://do/list-structured');
  const metrics: MetricEntry[] = await resp.json();

  const byJob = new Map<string, typeof metrics>();
  for (const m of metrics) {
    if (!byJob.has(m.job)) byJob.set(m.job, []);
    byJob.get(m.job)!.push(m);
  }

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prometheus Pushgateway</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
    h1 { margin: 0 0 8px 0; color: #ff6b6b; font-size: 24px; }
    .header { margin-bottom: 20px; }
    .header p { margin: 4px 0; color: #b0b0b0; font-size: 14px; }
    .job-card { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
    .job-header { background: #333; padding: 12px 16px; border-bottom: 1px solid #555; cursor: pointer; display: flex; align-items: center; }
    .job-header h3 { margin: 0; font-size: 16px; color: #e0e0e0; }
    .job-header .count { margin-left: auto; font-size: 12px; color: #aaa; }
    .instance-row { padding: 8px 16px 8px 32px; border-bottom: 1px solid #333; display: flex; align-items: center; font-size: 13px; }
    .instance-row:last-child { border-bottom: none; }
    .instance-row a { color: #ff6b6b; text-decoration: none; }
    .instance-row a:hover { text-decoration: underline; }
    .instance-row .actions { margin-left: auto; }
    .instance-row .actions button { background: #444; border: 1px solid #666; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; margin-left: 4px; color: #e0e0e0; }
    .instance-row .actions button:hover { background: #555; }
    .instance-row .actions .del:hover { color: #ff6b6b; border-color: #ff6b6b; }
    pre { background: #1a1a1a; border: 1px solid #444; padding: 12px; border-radius: 4px; overflow-x: auto; max-height: 400px; font-size: 13px; margin: 8px 16px; color: #e0e0e0; }
    .empty { color: #888; font-style: italic; padding: 16px; }
    .footer { margin-top: 20px; font-size: 12px; color: #888; text-align: center; padding: 16px; border-top: 1px solid #444; }
    .footer-nav { margin-bottom: 12px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
    .footer-nav a { color: #ff6b6b; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; transition: background-color 0.2s; }
    .footer-nav a:hover { text-decoration: none; background-color: #333; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Prometheus Pushgateway</h1>
    <div style="text-align: right; margin-top: -32px;">
      <a href="/docs" style="color: #ff6b6b; text-decoration: none; font-size: 14px;">Usage Docs</a>
    </div>
  </div>`;

  if (byJob.size === 0) {
    html += '<p class="empty">No metrics have been pushed yet.</p>';
  } else {
    for (const [job, entries] of byJob) {
      html += `<div class="job-card">
        <div class="job-header">
          <h3>${escapeHtml(job)}</h3>
          <span class="count">${entries.length} grouping${entries.length !== 1 ? 's' : ''}</span>
        </div>`;
      for (const entry of entries) {
        const labelStr = Object.entries(entry.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(', ');
        const path = `/metrics/job/${encodeURIComponent(job)}${encodeLabelParts(entry.labels)}`;
        const contentPreview = (entry.content.length > 200
          ? entry.content.substring(0, 200) + '...'
          : entry.content).replace(/`/g, '\\`');
        html += `<div class="instance-row">
          <span>${labelStr || '(no additional labels)'}</span>
          <span class="actions">
            <a href="${path}" target="_blank" title="View metrics">View</a>
            <button class="del" onclick="del(${JSON.stringify(path)})">Delete</button>
          </span>
        </div>
        <pre>${escapeHtml(contentPreview)}</pre>`;
      }
      html += '</div>';
    }
  }

  html += `<script>
    async function del(path) {
      if (!confirm('Delete these metrics?')) return;
      try {
        const r = await fetch(path, { method: 'DELETE' });
        if (r.ok) location.reload();
        else alert('Delete failed: ' + r.status);
      } catch(e) { alert('Error: ' + e.message); }
    }
  </script>
  <div class="footer">
    <div class="footer-nav">
      <a href="/">Home</a>
      <a href="/metrics">Metrics</a>
      <a href="/api/v1/targets">Targets</a>
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    <a href="https://github.com/rossigee/cloudflare-push-gateway" target="_blank" style="color: #888; text-decoration: none; display: inline-flex; align-items: center;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
      </svg>
      cloudflare-push-gateway v${VERSION}
    </a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleDocs(env: Env): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Guide - Prometheus Pushgateway</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
    h1 { margin: 0 0 8px 0; color: #ff6b6b; font-size: 24px; }
    .header { margin-bottom: 20px; }
    .nav { margin-bottom: 20px; }
    .nav a { margin-right: 16px; color: #ff6b6b; text-decoration: none; font-size: 14px; }
    .nav a:hover { text-decoration: underline; }
    .section { background: #2d2d2d; border: 1px solid #444; border-radius: 8px; margin-bottom: 20px; overflow: hidden; }
    .section-header { background: #333; padding: 16px; border-bottom: 1px solid #555; }
    .section-header h2 { margin: 0; font-size: 18px; color: #e0e0e0; }
    .section-content { padding: 16px; }
    pre { background: #1a1a1a; border: 1px solid #444; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; margin: 8px 0; color: #e0e0e0; }
    code { background: #444; padding: 2px 6px; border-radius: 3px; font-size: 12px; color: #e0e0e0; }
    .method { margin-bottom: 16px; }
    .method h3 { margin: 8px 0; color: #ff6b6b; }
    .back-link { margin-top: 20px; }
    .back-link a { color: #b0b0b0; text-decoration: none; }
    .back-link a:hover { text-decoration: underline; }
    .footer { margin-top: 20px; font-size: 12px; color: #888; text-align: center; padding: 16px; border-top: 1px solid #444; }
    .footer-nav { margin-bottom: 12px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap; }
    .footer-nav a { color: #ff6b6b; text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; transition: background-color 0.2s; }
    .footer-nav a:hover { text-decoration: none; background-color: #333; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Authentication Guide</h1>
    <p>Detailed instructions for authenticating with the Prometheus Pushgateway</p>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>API Overview</h2>
    </div>
    <div class="section-content">
      <p>This API provides Prometheus Pushgateway-compatible endpoints for pushing and retrieving metrics. Authentication is optional but recommended for production deployments.</p>
      <p><strong>Base URL:</strong> <code>https://your-worker.workers.dev</code></p>
      <p><strong>Content Type:</strong> Metrics endpoints return <code>text/plain; version=0.0.4</code> (Prometheus format)</p>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>REST API Reference</h2>
    </div>
    <div class="section-content">
      <div class="method">
        <h3>Push Metrics</h3>
        <pre><strong>PUT/POST</strong> /metrics/job/{job}[/{label}/{value}]...</pre>
        <p>Push or replace metrics for a grouping. Additional labels can be specified as path parameters.</p>
        <p><strong>Parameters:</strong></p>
        <ul>
          <li><code>job</code> (path) - Job name</li>
          <li><code>label</code> (path, optional) - Additional grouping label name</li>
          <li><code>value</code> (path, optional) - Additional grouping label value</li>
        </ul>
        <p><strong>Body:</strong> Prometheus metrics in text format</p>
        <p><strong>Examples:</strong></p>
        <pre>curl -X PUT --data-binary 'cpu_usage 0.85' \\
  /metrics/job/my_job/instance/server1</pre>
      </div>

      <div class="method">
        <h3>Retrieve Metrics</h3>
        <pre><strong>GET</strong> /metrics/job/{job}[/{label}/{value}]...</pre>
        <p>Retrieve metrics for a specific grouping.</p>
        <p><strong>Parameters:</strong></p>
        <ul>
          <li><code>job</code> (path) - Job name</li>
          <li><code>label</code> (path, optional) - Additional grouping label name</li>
          <li><code>value</code> (path, optional) - Additional grouping label value</li>
        </ul>
        <p><strong>Response:</strong> Metrics in Prometheus text format</p>
        <pre>curl /metrics/job/my_job/instance/server1</pre>
      </div>

      <div class="method">
        <h3>Get All Metrics</h3>
        <pre><strong>GET</strong> /metrics</pre>
        <p>Retrieve all metrics across all jobs and groupings.</p>
        <p><strong>Response:</strong> All metrics in Prometheus text format</p>
        <pre>curl /metrics</pre>
      </div>

      <div class="method">
        <h3>Delete Metrics</h3>
        <pre><strong>DELETE</strong> /metrics/job/{job}[/{label}/{value}]...</pre>
        <p>Delete metrics for a specific grouping.</p>
        <p><strong>Parameters:</strong></p>
        <ul>
          <li><code>job</code> (path) - Job name</li>
          <li><code>label</code> (path, optional) - Additional grouping label name</li>
          <li><code>value</code> (path, optional) - Additional grouping label value</li>
        </ul>
        <p><strong>Examples:</strong></p>
        <pre># Delete specific instance
curl -X DELETE /metrics/job/my_job/instance/server1

# Delete all instances for a job
curl -X DELETE /metrics/job/my_job</pre>
      </div>

      <div class="method">
        <h3>Get Targets</h3>
        <pre><strong>GET</strong> /api/v1/targets</pre>
        <p>Get list of all metric targets (Prometheus service discovery format).</p>
        <p><strong>Response:</strong> JSON with target information</p>
        <pre>curl /api/v1/targets</pre>
      </div>

      <div class="method">
        <h3>Health Check</h3>
        <pre><strong>GET</strong> /health</pre>
        <p>Get service health status.</p>
        <p><strong>Response:</strong> JSON health information</p>
        <pre>curl /health</pre>
      </div>

      <div class="method">
        <h3>Web UI</h3>
        <pre><strong>GET</strong> /</pre>
        <p>Access the web interface for browsing and managing metrics.</p>
        <p><strong>Response:</strong> HTML interface</p>
      </div>

      <div class="method">
        <h3>Documentation</h3>
        <pre><strong>GET</strong> /docs</pre>
        <p>Access this API documentation page.</p>
        <p><strong>Response:</strong> HTML documentation</p>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Authentication Methods</h2>
    </div>
    <div class="section-content">
      <p>Three authentication methods are supported, checked in order:</p>
      <ol>
        <li><strong>Basic Auth</strong> - Username/password via HTTP Basic authentication</li>
        <li><strong>JWT/OIDC</strong> - Bearer tokens validated against an OIDC provider</li>
        <li><strong>API Tokens</strong> - Static tokens for service-to-service authentication</li>
      </ol>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Basic Authentication</h2>
    </div>
    <div class="section-content">
      <div class="method">
        <h3>Configuration</h3>
        <p>Set these environment variables:</p>
        <pre>PUSHGATEWAY_AUTH_USER=admin
PUSHGATEWAY_AUTH_PASS=your-secure-password</pre>
        <p>For production, use Cloudflare Secrets:</p>
        <pre>npx wrangler secret put PUSHGATEWAY_AUTH_USER
npx wrangler secret put PUSHGATEWAY_AUTH_PASS</pre>
      </div>
      <div class="method">
        <h3>Usage Examples</h3>
        <pre># Using curl -u flag
curl -u admin:your-secure-password \\
  -X PUT --data-binary 'uptime_seconds 3600' \\
  https://your-worker.workers.dev/metrics/job/my_job

# Using Authorization header
curl -H "Authorization: Basic \$(echo -n 'admin:your-secure-password' | base64)" \\
  -X PUT --data-binary 'uptime_seconds 3600' \\
  https://your-worker.workers.dev/metrics/job/my_job</pre>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>JWT/OIDC Authentication</h2>
    </div>
    <div class="section-content">
      <div class="method">
        <h3>Configuration</h3>
        <p>Set these environment variables:</p>
        <pre>JWT_ISSUER=https://accounts.google.com
JWT_AUDIENCE=your-oidc-client-id
JWKS_URI=https://accounts.google.com/.well-known/jwks.json</pre>
        <p><code>JWKS_URI</code> is optional and defaults to <code>{issuer}/.well-known/jwks.json</code>.</p>
        <p>For production, use Cloudflare Secrets:</p>
        <pre>npx wrangler secret put JWT_ISSUER
npx wrangler secret put JWT_AUDIENCE</pre>
      </div>
      <div class="method">
        <h3>Usage Examples</h3>
        <pre># Using Authorization header
curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6..." \\
  -X PUT --data-binary 'uptime_seconds 3600' \\
  https://your-worker.workers.dev/metrics/job/my_job</pre>
        <p>Obtain JWT tokens from your OIDC provider (Google, Auth0, etc.).</p>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>API Token Authentication</h2>
    </div>
    <div class="section-content">
      <div class="method">
        <h3>Configuration</h3>
        <p>Set this environment variable with comma-separated tokens:</p>
        <pre>API_TOKENS=token1,token2,token3</pre>
        <p>For production, use Cloudflare Secrets:</p>
        <pre>npx wrangler secret put API_TOKENS</pre>
      </div>
      <div class="method">
        <h3>Usage Examples</h3>
        <pre># Using Bearer header
curl -H "Authorization: Bearer token1" \\
  -X PUT --data-binary 'uptime_seconds 3600' \\
  https://your-worker.workers.dev/metrics/job/my_job

# Using X-API-Key header
curl -H "X-API-Key: token1" \\
  -X PUT --data-binary 'uptime_seconds 3600' \\
  https://your-worker.workers.dev/metrics/job/my_job</pre>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>Authentication Flow</h2>
    </div>
    <div class="section-content">
      <p>When authentication is configured, requests are validated in this order:</p>
      <ol>
        <li><strong>Authorization: Bearer &lt;token&gt;</strong> → Try JWT validation → If fails, try API tokens → If fails, return 401</li>
        <li><strong>Authorization: Basic &lt;creds&gt;</strong> → Check username/password → If fails, return 401</li>
        <li><strong>X-API-Key: &lt;token&gt;</strong> → Check API tokens → If fails, return 401</li>
        <li><strong>No auth headers</strong> → Return 401</li>
      </ol>
      <p><strong>Note:</strong> Authentication is bypassed for requests from localhost (development/testing).</p>
    </div>
  </div>

  <div class="back-link">
    <a href="/">← Back to Home</a>
  </div>

  <div class="footer">
    <div class="footer-nav">
      <a href="/">Home</a>
      <a href="/metrics">Metrics</a>
      <a href="/api/v1/targets">Targets</a>
      <a href="/health">Health</a>
      <a href="/docs">Docs</a>
    </div>
    <a href="https://github.com/rossigee/cloudflare-push-gateway" target="_blank" style="color: #888; text-decoration: none; display: inline-flex; align-items: center;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
      </svg>
      cloudflare-push-gateway v${VERSION}
    </a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (!(await authenticate(request, env))) return unauthorized(env);
  return Response.json({
    status: 'healthy',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (true) {
        case path === '/' || path === '':
          if (!(await authenticate(request, env))) return unauthorized(env);
          return handleUI(env);
        case path === '/docs':
          if (!(await authenticate(request, env))) return unauthorized(env);
          return handleDocs(env);
        case path === '/health':
          return handleHealth(request, env);
        case path === '/metrics':
          if (!(await authenticate(request, env))) return unauthorized(env);
          return handleMetricsAll(env);
        case path === '/api/v1/targets':
          if (!(await authenticate(request, env))) return unauthorized(env);
          return handleApiV1Targets(env);
        case path.startsWith('/metrics/job/'):
          if (!(await authenticate(request, env))) return unauthorized(env);
          return handleMetricsJob(request, env);
        case path === '/favicon.ico':
          // Return a simple transparent 16x16 favicon
          const favicon = new Uint8Array([
            0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x68, 0x04,
            0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x20, 0x00,
            0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
          ]);
          return new Response(favicon, {
            headers: { 'Content-Type': 'image/x-icon' },
          });
        default:
          if (!(await authenticate(request, env))) return unauthorized(env);
          return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Internal Server Error: ${message}`, { status: 500 });
    }
  },
};
