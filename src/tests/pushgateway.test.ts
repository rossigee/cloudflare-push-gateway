import { SELF, reset, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const baseUrl = 'http://localhost';

describe('Prometheus Pushgateway API', () => {
  beforeEach(async () => {
    await reset();
  });

  describe('PUT /metrics/job/<job>/instance/<instance>', () => {
    it('should store and retrieve metrics with grouping labels', async () => {
      const putResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`,
        {
          method: 'PUT',
          body: 'cpu_usage 0.85\nmemory_usage_bytes 4096',
        }
      );
      expect(putResp.status).toBe(200);

      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`
      );
      expect(getResp.status).toBe(200);
      expect(await getResp.text()).toBe(
        'cpu_usage{job="myjob", instance="myinstance"} 0.85\nmemory_usage_bytes{job="myjob", instance="myinstance"} 4096'
      );
    });

    it('should handle metrics with existing labels', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`,
        {
          method: 'PUT',
          body: 'http_requests_total{method="GET"} 100\nhttp_requests_total{method="POST"} 50',
        }
      );

      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`
      );
      const body = await getResp.text();
      expect(body).toContain('http_requests_total{method="GET", job="myjob", instance="myinstance"} 100');
      expect(body).toContain('http_requests_total{method="POST", job="myjob", instance="myinstance"} 50');
    });

    it('should push to job without instance', async () => {
      const putResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob`,
        {
          method: 'PUT',
          body: 'my_metric 1',
        }
      );
      expect(putResp.status).toBe(200);

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/myjob`);
      const body = await getResp.text();
      expect(body).toContain('my_metric{job="myjob"} 1');
    });
  });

  describe('POST /metrics/job/<job>/instance/<instance>', () => {
    it('should replace metrics (same as PUT)', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/test/instance/x`,
        { method: 'PUT', body: 'first 1' }
      );

      await SELF.fetch(
        `${baseUrl}/metrics/job/test/instance/x`,
        { method: 'POST', body: 'second 2' }
      );

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/test/instance/x`);
      const body = await getResp.text();
      expect(body).toContain('second{job="test", instance="x"} 2');
      expect(body).not.toContain('first');
    });
  });

  describe('GET /metrics/job/<job>/instance/<instance>', () => {
    it('should return 404 for non-existent instance', async () => {
      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/nonexistent/instance/x`
      );
      expect(getResp.status).toBe(404);
    });

    it('should return stored metrics for specific instance', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`,
        { method: 'PUT', body: 'test_metric 42' }
      );

      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/myinstance`
      );
      expect(getResp.status).toBe(200);
      expect(await getResp.text()).toContain('test_metric');
    });
  });

  describe('GET /metrics/job/<job>', () => {
    it('should return all instances for a job', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/node/instance/server1`,
        { method: 'PUT', body: 'cpu 0.5' }
      );
      await SELF.fetch(
        `${baseUrl}/metrics/job/node/instance/server2`,
        { method: 'PUT', body: 'mem 2048' }
      );

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/node`);
      const body = await getResp.text();
      expect(body).toContain('cpu{job="node", instance="server1"} 0.5');
      expect(body).toContain('mem{job="node", instance="server2"} 2048');
    });
  });

  describe('GET /metrics', () => {
    it('should return all metrics across all jobs', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/job1/instance/i1`,
        { method: 'PUT', body: 'm1 1' }
      );
      await SELF.fetch(
        `${baseUrl}/metrics/job/job2/instance/i2`,
        { method: 'PUT', body: 'm2 2' }
      );

      const getResp = await SELF.fetch(`${baseUrl}/metrics`);
      const body = await getResp.text();
      expect(body).toContain('m1{job="job1", instance="i1"} 1');
      expect(body).toContain('m2{job="job2", instance="i2"} 2');
    });

    it('should return empty string when no metrics', async () => {
      const getResp = await SELF.fetch(`${baseUrl}/metrics`);
      expect(await getResp.text()).toBe('');
    });
  });

  describe('DELETE /metrics/job/<job>/instance/<instance>', () => {
    it('should delete a specific instance', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst1`,
        { method: 'PUT', body: 'm1 1' }
      );
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst2`,
        { method: 'PUT', body: 'm2 2' }
      );

      const delResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst1`,
        { method: 'DELETE' }
      );
      expect(delResp.status).toBe(200);

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/myjob/instance/inst1`);
      expect(getResp.status).toBe(404);

      const getResp2 = await SELF.fetch(`${baseUrl}/metrics/job/myjob/instance/inst2`);
      expect(getResp2.status).toBe(200);
    });
  });

  describe('DELETE /metrics/job/<job>', () => {
    it('should delete all instances for a job', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst1`,
        { method: 'PUT', body: 'm1 1' }
      );
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst2`,
        { method: 'PUT', body: 'm2 2' }
      );

      const delResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob`,
        { method: 'DELETE' }
      );
      expect(delResp.status).toBe(200);

      const getResp = await SELF.fetch(`${baseUrl}/metrics`);
      const body = await getResp.text();
      expect(body).not.toContain('m1');
      expect(body).not.toContain('m2');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const resp = await SELF.fetch(`${baseUrl}/health`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data).toHaveProperty('status', 'healthy');
      expect(data).toHaveProperty('version');
      expect(data).toHaveProperty('timestamp');
    });
  });

  describe('GET /', () => {
    it('should return HTML UI', async () => {
      const resp = await SELF.fetch(`${baseUrl}/`);
      expect(resp.status).toBe(200);
      const contentType = resp.headers.get('Content-Type');
      expect(contentType).toContain('text/html');
      const body = await resp.text();
      expect(body).toContain('Prometheus Pushgateway');
    });

    it('should show metrics in UI when data exists', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/inst1`,
        { method: 'PUT', body: 'test_metric 42' }
      );

      const resp = await SELF.fetch(`${baseUrl}/`);
      const body = await resp.text();
      expect(body).toContain('myjob');
      expect(body).toContain('test_metric');
    });
  });

  describe('Content-Type headers', () => {
    it('should return proper content-type for metrics', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/i`,
        { method: 'PUT', body: 'm 1' }
      );

      const resp = await SELF.fetch(`${baseUrl}/metrics`);
      expect(resp.headers.get('Content-Type')).toBe('text/plain; version=0.0.4');
    });
  });

  describe('Multiple grouping labels', () => {
    it('should handle additional grouping labels beyond instance', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/region/us-east1/env/production/instance/srv1`,
        { method: 'PUT', body: 'latency_seconds 0.05' }
      );

      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/region/us-east1/env/production/instance/srv1`
      );
      expect(getResp.status).toBe(200);
      const body = await getResp.text();
      expect(body).toContain('latency_seconds{job="myjob", region="us-east1", env="production", instance="srv1"} 0.05');
    });
  });

  describe('HELP and TYPE lines', () => {
    it('should preserve HELP and TYPE lines when adding grouping labels', async () => {
      const prometheusText = [
        '# HELP cpu_usage CPU usage percentage',
        '# TYPE cpu_usage gauge',
        'cpu_usage 0.85',
        '# HELP memory_usage_bytes Memory usage in bytes',
        '# TYPE memory_usage_bytes gauge',
        'memory_usage_bytes 4096',
      ].join('\n');

      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/i1`,
        { method: 'PUT', body: prometheusText }
      );

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/myjob/instance/i1`);
      const body = await getResp.text();
      const lines = body.split('\n');
      expect(lines).toContain('# HELP cpu_usage CPU usage percentage');
      expect(lines).toContain('# TYPE cpu_usage gauge');
      expect(lines).toContain('cpu_usage{job="myjob", instance="i1"} 0.85');
      expect(lines).toContain('# HELP memory_usage_bytes Memory usage in bytes');
      expect(lines).toContain('# TYPE memory_usage_bytes gauge');
      expect(lines).toContain('memory_usage_bytes{job="myjob", instance="i1"} 4096');
    });
  });

  describe('Empty body', () => {
    it('should accept empty body on push', async () => {
      const resp = await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/i1`,
        { method: 'PUT', body: '' }
      );
      expect(resp.status).toBe(200);

      const getResp = await SELF.fetch(`${baseUrl}/metrics/job/myjob/instance/i1`);
      expect(await getResp.text()).toBe('');
    });
  });

  describe('Special characters in names', () => {
    it('should handle URL-encoded characters in job and instance names', async () => {
      const job = 'my-job/v2';
      const instance = 'server (us-east-1)';
      const encodedJob = encodeURIComponent(job);
      const encodedInstance = encodeURIComponent(instance);

      const putResp = await SELF.fetch(
        `${baseUrl}/metrics/job/${encodedJob}/instance/${encodedInstance}`,
        { method: 'PUT', body: 'test_metric 1' }
      );
      expect(putResp.status).toBe(200);

      const getResp = await SELF.fetch(
        `${baseUrl}/metrics/job/${encodedJob}/instance/${encodedInstance}`
      );
      expect(getResp.status).toBe(200);
      const body = await getResp.text();
      expect(body).toContain(`test_metric{job="${job}", instance="${instance}"} 1`);
    });
  });

  describe('/api/v1/targets', () => {
    it('should return empty targets list when no metrics', async () => {
      const resp = await SELF.fetch(`${baseUrl}/api/v1/targets`);
      const data = await resp.json();
      expect(data).toHaveProperty('status', 'success');
      expect(data.data).toEqual([]);
    });

    it('should list pushed metrics as targets', async () => {
      await SELF.fetch(
        `${baseUrl}/metrics/job/myjob/instance/i1`,
        { method: 'PUT', body: 'm 1' }
      );

      const resp = await SELF.fetch(`${baseUrl}/api/v1/targets`);
      const data = await resp.json();
      expect(data.status).toBe('success');
      expect(data.data).toHaveLength(1);
      expect(data.data[0].labels).toEqual({ job: 'myjob', instance: 'i1' });
      expect(data.data[0].health).toBe('up');
    });
  });

  describe('Authentication', () => {
    const hasBasicAuth = !!(env as any).PUSHGATEWAY_AUTH_USER;
    const hasApiToken = !!(env as any).API_TOKENS;

    (hasBasicAuth ? it : it.skip)('should reject unauthenticated requests when auth is configured', async () => {
      const resp = await SELF.fetch(`${baseUrl}/metrics`);
      expect(resp.status).toBe(401);
    });

    (hasBasicAuth ? it : it.skip)('should accept authenticated requests with basic auth', async () => {
      const user = (env as any).PUSHGATEWAY_AUTH_USER;
      const pass = (env as any).PUSHGATEWAY_AUTH_PASS;
      const encoded = btoa(`${user}:${pass}`);
      const resp = await SELF.fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Basic ${encoded}` },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should accept API token via Bearer header', async () => {
      const token = (env as any).API_TOKENS.split(',')[0].trim();
      const resp = await SELF.fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should accept API token via X-API-Key header', async () => {
      const token = (env as any).API_TOKENS.split(',')[0].trim();
      const resp = await SELF.fetch(`${baseUrl}/metrics`, {
        headers: { 'X-API-Key': token },
      });
      expect(resp.status).toBe(200);
    });

    (hasApiToken ? it : it.skip)('should reject invalid Bearer token', async () => {
      const resp = await SELF.fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(resp.status).toBe(401);
    });
  });
});
