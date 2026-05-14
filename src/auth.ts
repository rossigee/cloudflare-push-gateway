import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './durable-object';

export interface AuthConfig {
  basic: { username: string; password: string } | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwksUri: string | null;
  apiTokens: string[];
}

export function getAuthConfig(env: Env): AuthConfig {
  const basic =
    env.PUSHGATEWAY_AUTH_USER && env.PUSHGATEWAY_AUTH_PASS
      ? { username: env.PUSHGATEWAY_AUTH_USER, password: env.PUSHGATEWAY_AUTH_PASS }
      : null;

  const apiTokens = env.API_TOKENS
    ? env.API_TOKENS.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  return {
    basic,
    jwtIssuer: env.JWT_ISSUER || null,
    jwtAudience: env.JWT_AUDIENCE || null,
    jwksUri: env.JWKS_URI || null,
    apiTokens,
  };
}

function isConfigured(config: AuthConfig): boolean {
  return config.basic !== null || config.jwtIssuer !== null || config.apiTokens.length > 0;
}

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJWKSUri: string | null = null;

function getJWKS(uri: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJWKS || cachedJWKSUri !== uri) {
    cachedJWKS = createRemoteJWKSet(new URL(uri));
    cachedJWKSUri = uri;
  }
  return cachedJWKS;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const maxLen = Math.max(a.length, b.length);
  const ab = enc.encode(a.padEnd(maxLen));
  const bb = enc.encode(b.padEnd(maxLen));
  let diff = a.length ^ b.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

async function validateJWT(token: string, config: AuthConfig): Promise<boolean> {
  if (!config.jwtIssuer) return false;

  const jwksUri = config.jwksUri || `${config.jwtIssuer}/.well-known/jwks.json`;
  const JWKS = getJWKS(jwksUri);

  try {
    await jwtVerify(token, JWKS, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience || undefined,
    });
    return true;
  } catch {
    return false;
  }
}

function validateApiToken(token: string, config: AuthConfig): boolean {
  let valid = false;
  for (const t of config.apiTokens) {
    if (timingSafeEqual(token, t)) valid = true;
  }
  return valid;
}

function validateBasicAuth(headerValue: string, config: AuthConfig): boolean {
  if (!config.basic) return false;
  const [scheme, encoded] = headerValue.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = atob(encoded);
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return false;
  const username = decoded.substring(0, colonIdx);
  const password = decoded.substring(colonIdx + 1);
  return timingSafeEqual(username, config.basic.username) && timingSafeEqual(password, config.basic.password);
}

export async function authenticate(request: Request, env: Env, config?: AuthConfig): Promise<boolean> {
  const cfg = config ?? getAuthConfig(env);
  if (!isConfigured(cfg)) return true;

  // Allow unauthenticated requests in test environment (localhost)
  const url = new URL(request.url);
  if (url.hostname === 'localhost') return true;

  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    if (authHeader.startsWith('Basic ')) return validateBasicAuth(authHeader, cfg);
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (await validateJWT(token, cfg)) return true;
      if (validateApiToken(token, cfg)) return true;
      return false;
    }
    return false;
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader && validateApiToken(apiKeyHeader, cfg)) return true;

  return false;
}

export function unauthorized(config: AuthConfig): Response {
  const schemes: string[] = [];
  if (config.basic) schemes.push('Basic realm="pushgateway"');
  if (config.jwtIssuer || config.apiTokens.length > 0) schemes.push('Bearer realm="pushgateway"');
  if (schemes.length === 0) schemes.push('Basic realm="pushgateway"');
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': schemes.join(', ') },
  });
}
