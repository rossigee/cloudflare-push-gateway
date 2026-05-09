import { DurableObject } from 'cloudflare:workers';

export interface Env {
  METRICS_STORE: DurableObjectNamespace<MetricsStore>;
  PUSHGATEWAY_AUTH_USER?: string;
  PUSHGATEWAY_AUTH_PASS?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWKS_URI?: string;
  API_TOKENS?: string;
}

export interface MetricEntry {
  job: string;
  labels: Record<string, string>;
  content: string;
  updatedAt: number;
}

export const MAX_BODY_SIZE = 10 * 1024 * 1024;

type Labels = Record<string, string>;

const TS_SUFFIX = '\t__ts';

function serializeKey(job: string, additionalLabels: Labels): string {
  const parts = [job];
  const sorted = Object.entries(additionalLabels).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of sorted) {
    parts.push(`${k}\0${v}`);
  }
  return parts.join('\t');
}

function tsKey(contentKey: string): string {
  return contentKey + TS_SUFFIX;
}

function parseKey(key: string): { job: string; additionalLabels: Labels } | null {
  if (key.endsWith(TS_SUFFIX)) return null;
  const parts = key.split('\t');
  if (parts.length < 1) return null;
  const job = parts[0];
  const additionalLabels: Labels = {};
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf('\0');
    if (idx === -1) return null;
    additionalLabels[parts[i].substring(0, idx)] = parts[i].substring(idx + 1);
  }
  return { job, additionalLabels };
}

function addGroupingLabelsToLine(line: string, groupingLabels: Labels): string {
  if (line.length === 0 || line.startsWith('#') || line.startsWith('//')) return line;
  const hasCR = line.endsWith('\r');
  const trimmed = line.trim();
  if (trimmed.length === 0) return line;

  const braceIdx = trimmed.indexOf('{');
  const closeIdx = trimmed.indexOf('}', braceIdx);

  let result: string;
  if (braceIdx !== -1 && closeIdx !== -1) {
    const before = trimmed.substring(0, braceIdx);
    let innerContent = trimmed.substring(braceIdx + 1, closeIdx).trim();
    const after = trimmed.substring(closeIdx + 1);

    const existingLabels = new Set(
      innerContent.split(',').map(p => p.split('=')[0].trim()).filter(Boolean)
    );
    const newLabels: string[] = [];
    for (const [k, v] of Object.entries(groupingLabels)) {
      if (!existingLabels.has(k)) {
        newLabels.push(`${k}="${v}"`);
      }
    }
    if (newLabels.length > 0) {
      innerContent = innerContent ? `${innerContent}, ${newLabels.join(', ')}` : newLabels.join(', ');
    }
    result = `${before}{${innerContent}}${after}`;
  } else {
    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx === -1) {
      result = trimmed;
    } else {
      const name = trimmed.substring(0, spaceIdx);
      const value = trimmed.substring(spaceIdx + 1);
      const labelStr = Object.entries(groupingLabels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      result = `${name}{${labelStr}} ${value}`;
    }
  }

  return hasCR ? result + '\r' : result;
}

function addGroupingLabels(text: string, groupingLabels: Labels): string {
  if (Object.keys(groupingLabels).length === 0) return text;
  return text.split('\n').map(l => addGroupingLabelsToLine(l, groupingLabels)).join('\n');
}

export class MetricsStore extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/list-structured') {
      const entries = await this.ctx.storage.list<string>();
      const all: MetricEntry[] = [];

      for (const [key, content] of entries) {
        if (key.endsWith(TS_SUFFIX)) continue;
        const parsed = parseKey(key);
        if (parsed && typeof content === 'string') {
          const tsStr = await this.ctx.storage.get<string>(tsKey(key));
          all.push({
            job: parsed.job,
            labels: parsed.additionalLabels,
            content,
            updatedAt: tsStr ? parseInt(tsStr, 10) : 0,
          });
        }
      }

      return Response.json(all);
    }

    if (method === 'GET' && path === '/list') {
      return MetricsStore.concatResults((await this.ctx.storage.list<string>()).entries());
    }

    if (method === 'GET' && path.startsWith('/list/')) {
      const job = decodeURIComponent(path.substring(6));
      const keyed = await this.ctx.storage.list<string>({ prefix: job + '\t' });
      const allContent: string[] = [];
      for (const [key, value] of keyed) {
        if (!key.endsWith(TS_SUFFIX) && typeof value === 'string') {
          allContent.push(value);
        }
      }
      const directEntry = await this.ctx.storage.get<string>(job);
      if (directEntry) allContent.push(directEntry);
      const combined = allContent.join('\n');
      return new Response(combined, {
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      });
    }

    if (method === 'DELETE' && path.startsWith('/drop/')) {
      const job = decodeURIComponent(path.substring(6));
      const entries = await this.ctx.storage.list({ prefix: job + '\t' });
      const keysToDelete: string[] = [];
      for (const [key] of entries) {
        keysToDelete.push(key as string);
      }
      const directKeys = [job, tsKey(job)];
      for (const dk of directKeys) {
        if (!keysToDelete.includes(dk)) keysToDelete.push(dk);
      }
      await this.ctx.storage.delete(keysToDelete);
      return new Response(null, { status: 200 });
    }

    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length < 2) {
      return new Response('Not Found', { status: 404 });
    }

    const job = decodeURIComponent(parts[1]);
    const additionalLabels: Labels = {};
    for (let i = 2; i + 1 < parts.length; i += 2) {
      additionalLabels[decodeURIComponent(parts[i])] = decodeURIComponent(parts[i + 1]);
    }

    if (method === 'PUT' || method === 'POST') {
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return new Response('Request body too large', { status: 413 });
      }
      const rawText = await request.text();
      if (rawText.length > MAX_BODY_SIZE) {
        return new Response('Request body too large', { status: 413 });
      }
      const groupingLabels: Labels = { job, ...additionalLabels };
      const processedText = addGroupingLabels(rawText, groupingLabels);
      const ck = serializeKey(job, additionalLabels);
      await this.ctx.storage.put(ck, processedText);
      await this.ctx.storage.put(tsKey(ck), String(Date.now()));
      return new Response(null, { status: 200 });
    }

    if (method === 'GET') {
      const stored = await this.ctx.storage.get<string>(serializeKey(job, additionalLabels));
      if (!stored) return new Response('', { status: 404 });
      return new Response(stored, {
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      });
    }

    if (method === 'DELETE') {
      const ck = serializeKey(job, additionalLabels);
      await this.ctx.storage.delete([ck, tsKey(ck)]);
      return new Response(null, { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  private static concatResults(entries: IterableIterator<[string, unknown]>): Response {
    let allContent = '';
    for (const [key, value] of entries) {
      if (key.endsWith(TS_SUFFIX)) continue;
      if (typeof value === 'string') {
        if (allContent) allContent += '\n';
        allContent += value;
      }
    }
    return new Response(allContent, {
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
    });
  }
}
