import { MetricsStore, Env, MetricEntry, MAX_BODY_SIZE } from './durable-object';
import { authenticate, unauthorized } from './auth';

export { MetricsStore };

const VERSION = '0.1.0';

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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; color: #333; }
    h1 { margin: 0 0 8px 0; color: #e6522c; font-size: 24px; }
    .header { margin-bottom: 20px; }
    .header p { margin: 4px 0; color: #666; font-size: 14px; }
    .nav { margin-bottom: 20px; }
    .nav a { margin-right: 16px; color: #e6522c; text-decoration: none; font-size: 14px; }
    .nav a:hover { text-decoration: underline; }
    .nav code { background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .job-card { background: #fff; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
    .job-header { background: #fafafa; padding: 12px 16px; border-bottom: 1px solid #eee; cursor: pointer; display: flex; align-items: center; }
    .job-header h3 { margin: 0; font-size: 16px; }
    .job-header .count { margin-left: auto; font-size: 12px; color: #999; }
    .instance-row { padding: 8px 16px 8px 32px; border-bottom: 1px solid #f5f5f5; display: flex; align-items: center; font-size: 13px; }
    .instance-row:last-child { border-bottom: none; }
    .instance-row a { color: #e6522c; text-decoration: none; }
    .instance-row a:hover { text-decoration: underline; }
    .instance-row .actions { margin-left: auto; }
    .instance-row .actions button { background: none; border: 1px solid #ddd; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; margin-left: 4px; }
    .instance-row .actions button:hover { background: #f0f0f0; }
    .instance-row .actions .del:hover { color: #e74c3c; border-color: #e74c3c; }
    pre { background: #f8f8f8; border: 1px solid #ddd; padding: 12px; border-radius: 4px; overflow-x: auto; max-height: 400px; font-size: 13px; margin: 8px 16px; }
    .empty { color: #999; font-style: italic; padding: 16px; }
    .footer { margin-top: 20px; font-size: 12px; color: #999; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Prometheus Pushgateway</h1>
    <p>Push metrics: <code>curl -X PUT --data-binary @metrics.txt https://your-worker.workers.dev/metrics/job/&lt;job&gt;/instance/&lt;instance&gt;</code></p>
  </div>
  <div class="nav">
    <a href="/">Home</a>
    <a href="/metrics">/metrics</a>
    <a href="/api/v1/targets">/api/v1/targets</a>
    <a href="/health">/health</a>
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
        const contentPreview = entry.content.length > 200
          ? entry.content.substring(0, 200) + '...'
          : entry.content;
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
  <div class="footer">cloudflare-push-gateway v${VERSION}</div>
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
