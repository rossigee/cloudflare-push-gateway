import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './durable-object';

export interface AuthConfig {
  basic: { username: string; password: string } | null;
  jwtIssuer: string | null;
  jwtAudience: string | null;
  jwksUri: string | null;
  apiTokens: string[];
  oauth2: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string | null;
  } | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function getAuthConfig(env: Env): AuthConfig {
  const basic =
    env.PUSHGATEWAY_AUTH_USER && env.PUSHGATEWAY_AUTH_PASS
      ? { username: env.PUSHGATEWAY_AUTH_USER, password: env.PUSHGATEWAY_AUTH_PASS }
      : null;

  const apiTokens = env.API_TOKENS
    ? env.API_TOKENS.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  let oauth2: AuthConfig['oauth2'] = null;
  if (env.JWT_ISSUER && env.KEYCLOAK_CLIENT_SECRET) {
    const issuer = env.JWT_ISSUER;
    oauth2 = {
      authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
      clientId: 'push-gateway',
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
      redirectUri: env.BASE_URL ? `${env.BASE_URL}/oauth/callback` : null,
    };
  } else if (env.JWT_ISSUER) {
    // For test environments that only have JWT_ISSUER but not full OAuth2 setup
    console.warn('JWT_ISSUER configured but KEYCLOAK_CLIENT_SECRET missing - OAuth2 login disabled');
  }

  return {
    basic,
    jwtIssuer: env.JWT_ISSUER || null,
    jwtAudience: env.JWT_AUDIENCE || null,
    jwksUri: env.JWKS_URI || null,
    apiTokens,
    oauth2,
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

async function refreshToken(refreshToken: string, config: AuthConfig): Promise<boolean> {
  if (!config.oauth2?.tokenEndpoint) return false;

  try {
    const tokenResp = await fetch(config.oauth2.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.oauth2.clientId,
        client_secret: config.oauth2.clientSecret,
      }),
    });

    if (!tokenResp.ok) return false;

    const tokens = await tokenResp.json() as { access_token?: string };
    if (tokens.access_token) {
      console.log('Token refresh successful');
      return true;
    }
    return false;
  } catch (e) {
    console.error('Token refresh failed:', e);
    return false;
  }
}

async function validateJWT(token: string, config: AuthConfig): Promise<boolean> {
  if (!config.jwtIssuer) {
    console.error('JWT issuer not configured');
    return false;
  }

  const jwksUri = config.jwksUri || `${config.jwtIssuer}/.well-known/jwks.json`;
  const JWKS = getJWKS(jwksUri);

  try {
    await jwtVerify(token, JWKS, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience || undefined,
    });
    return true;
  } catch (e) {
    console.error('JWT validation error:', e instanceof Error ? e.message : String(e));
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

export async function authenticate(request: Request, env: Env, config?: AuthConfig): Promise<{ authenticated: boolean; redirect?: string }> {
  const cfg = config ?? getAuthConfig(env);
  if (!isConfigured(cfg)) return { authenticated: true };

  const url = new URL(request.url);
  if (url.hostname === 'localhost') return { authenticated: true };

  const sessionCookie = request.headers.get('Cookie')?.match(/pushgateway_session=([^;]+)/)?.[1];
  if (sessionCookie) {
    try {
      const sessionData: SessionTokens = JSON.parse(atob(sessionCookie));
      
      if (Date.now() > sessionData.expiresAt && sessionData.refreshToken) {
        console.log('Access token expired, attempting refresh...');
        const refreshed = await refreshToken(sessionData.refreshToken, cfg);
        if (refreshed) {
          return { authenticated: true };
        }
      }
      
      if (await validateJWT(sessionData.accessToken, cfg)) {
        return { authenticated: true };
      }
    } catch (e) {
      console.error('Session cookie parse error:', e);
    }
  }

  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    if (authHeader.startsWith('Basic ')) {
      const valid = validateBasicAuth(authHeader, cfg);
      return { authenticated: valid };
    }
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (await validateJWT(token, cfg)) return { authenticated: true };
      if (validateApiToken(token, cfg)) return { authenticated: true };
      return { authenticated: false };
    }
    return { authenticated: false };
  }

  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader && validateApiToken(apiKeyHeader, cfg)) return { authenticated: true };

  if (cfg.oauth2 && request.headers.get('Accept')?.includes('text/html')) {
    const state = btoa('/');
    const redirectUri = cfg.oauth2.redirectUri || `${url.origin}/oauth/callback`;
    const authUrl = new URL(cfg.oauth2.authorizationEndpoint);
    authUrl.searchParams.set('client_id', cfg.oauth2.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'openid');
    console.log('Redirecting to Keycloak:', authUrl.toString());
    return { authenticated: false, redirect: authUrl.toString() };
  }

  return { authenticated: false };
}

export function unauthorized(config: AuthConfig, redirectUrl?: string): Response {
  if (redirectUrl) {
    return Response.redirect(redirectUrl, 302);
  }
  const schemes: string[] = [];
  if (config.basic) schemes.push('Basic realm="pushgateway"');
  if (config.jwtIssuer || config.apiTokens.length > 0) schemes.push('Bearer realm="pushgateway"');
  if (schemes.length === 0) schemes.push('Basic realm="pushgateway"');
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': schemes.join(', ') },
  });
}

export function createSessionCookie(tokens: SessionTokens | string, path: string = '/'): Response {
  let sessionData: SessionTokens;
  
  if (typeof tokens === 'string') {
    sessionData = {
      accessToken: tokens,
      expiresAt: Date.now() + 3300000, // 55 minutes
    };
  } else {
    sessionData = tokens;
  }

  const encoded = btoa(JSON.stringify(sessionData));
  return new Response(null, {
    status: 302,
    headers: {
      'Location': path,
      'Set-Cookie': `pushgateway_session=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    },
  });
}

export function clearSessionCookie(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `pushgateway_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}
