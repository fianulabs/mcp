import { ComplianceMCP } from './compliance-mcp';
import { AuthHandler } from './auth/oauth-handler';
import { Auth0Handler } from './auth/auth0-handler';
import type { Env } from './types';

/**
 * Fianu Compliance Intelligence MCP Server
 * 
 * Implements OAuth 2.0 Authorization Code Flow with PKCE
 * using Auth0 as the identity provider.
 * 
 * Flow (per MCP spec and Cloudflare docs):
 * 1. Client discovers OAuth endpoints via /.well-known/oauth-authorization-server
 * 2. Client registers via POST /register (returns client_id)
 * 3. Client initiates auth via GET /authorize (redirects to Auth0)
 * 4. Auth0 authenticates user and redirects to /callback
 * 5. Server exchanges code and redirects back to client with MCP auth code
 * 6. Client exchanges MCP auth code via POST /token
 * 7. Client uses access token for MCP requests via /sse
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Log all requests for debugging - comprehensive logging
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    console.log('=== INCOMING REQUEST ===', {
      method: request.method,
      pathname: url.pathname,
      fullUrl: request.url,
      search: url.search,
      headers,
    });

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, { status: 204 }));
    }

    // ============================================
    // OAuth Protected Resource Metadata (RFC 9728)
    // This is what mcp-remote looks for first via WWW-Authenticate header
    // mcp-remote may request: /.well-known/oauth-protected-resource/sse (appends resource path)
    // ============================================
    if (url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/sse/.well-known/oauth-protected-resource' ||
        url.pathname.startsWith('/.well-known/oauth-protected-resource') ||
        url.pathname.endsWith('/.well-known/oauth-protected-resource')) {
      
      console.log('OAuth protected resource metadata request:', {
        pathname: url.pathname,
        fullUrl: request.url,
      });

      // Points to the authorization server metadata
      const resourceMetadata = {
        resource: `${baseUrl}/sse`,
        authorization_servers: [`${baseUrl}`],
        scopes_supported: ['openid', 'profile', 'email'],
        bearer_methods_supported: ['header'],
      };

      return addCorsHeaders(new Response(JSON.stringify(resourceMetadata), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      }));
    }

    // ============================================
    // OAuth Discovery Endpoint (RFC 8414)
    // mcp-remote may request: /.well-known/oauth-authorization-server/sse (appends resource path)
    // ============================================
    if (url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/sse/.well-known/oauth-authorization-server' ||
        url.pathname.startsWith('/.well-known/oauth-authorization-server') ||
        url.pathname.endsWith('/.well-known/oauth-authorization-server')) {
      
      console.log('OAuth authorization server metadata request:', {
        pathname: url.pathname,
        fullUrl: request.url,
      });

      // IMPORTANT: All endpoints must point to THIS server (the MCP server)
      // The MCP server acts as its own OAuth provider, delegating to Auth0
      const discoveryDoc = {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,  // OUR endpoint, not Auth0's
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email'],
      };

      const responseBody = JSON.stringify(discoveryDoc);
      console.log('=== RETURNING AUTH SERVER METADATA ===', {
        bodyLength: responseBody.length,
        body: responseBody,
      });

      return addCorsHeaders(new Response(responseBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
      }));
    }

    // ============================================
    // OAuth Client Registration (Dynamic Client Registration)
    // ============================================
    if (url.pathname === '/register') {
      console.log('OAuth registration request');

      if (request.method !== 'POST') {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Registration endpoint only accepts POST requests',
        }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Generate a client_id for this MCP client
      // In production, you might want to store and validate these
      const clientId = `mcp_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;

      const registrationResponse = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: ['http://localhost:9935/oauth/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none', // PKCE flow
        application_type: 'native',
      };

      console.log('Registration response:', { clientId });

      return addCorsHeaders(new Response(JSON.stringify(registrationResponse), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // ============================================
    // OAuth Authorization Endpoint
    // ============================================
    if (url.pathname === '/authorize') {
      const authHandler = new AuthHandler(env);
      return authHandler.fetch(request);
    }

    // ============================================
    // OAuth Callback (from Auth0)
    // ============================================
    if (url.pathname === '/callback') {
      const authHandler = new AuthHandler(env);
      return authHandler.fetch(request);
    }

    // ============================================
    // OAuth Token Endpoint
    // ============================================
    if (url.pathname === '/token') {
      console.log('Token exchange request');

      if (request.method !== 'POST') {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Token endpoint only accepts POST requests',
        }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Parse request body
      let body: Record<string, string>;
      try {
        const contentType = request.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          body = await request.json();
        } else {
          const formData = await request.formData();
          body = Object.fromEntries(formData.entries()) as Record<string, string>;
        }
      } catch (error) {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const grantType = body.grant_type;
      const code = body.code;
      const codeVerifier = body.code_verifier;
      const redirectUri = body.redirect_uri;

      console.log('Token request:', {
        grantType,
        hasCode: !!code,
        hasCodeVerifier: !!codeVerifier,
        redirectUri,
      });

      if (grantType !== 'authorization_code') {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'unsupported_grant_type',
          error_description: 'Only authorization_code grant type is supported',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      if (!code) {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Authorization code is required',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Retrieve the stored auth code data
      const authCodeDataJson = await env.CACHE_KV.get(`mcp_auth_code:${code}`);
      if (!authCodeDataJson) {
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid or expired',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // Delete the auth code (single use)
      await env.CACHE_KV.delete(`mcp_auth_code:${code}`);

      const authCodeData = JSON.parse(authCodeDataJson);

      // Verify PKCE code_verifier if code_challenge was provided
      if (authCodeData.mcpCodeChallenge && codeVerifier) {
        const expectedChallenge = await generateCodeChallenge(codeVerifier);
        if (expectedChallenge !== authCodeData.mcpCodeChallenge) {
          return addCorsHeaders(new Response(JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Code verifier does not match code challenge',
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }

      // Return the Auth0 access token to the MCP client
      // The MCP client will use this token for subsequent requests
      const tokenResponse = {
        access_token: authCodeData.auth0AccessToken,
        token_type: 'Bearer',
        expires_in: authCodeData.auth0ExpiresIn || 86400,
        scope: 'openid profile email',
        // Include id_token if available
        ...(authCodeData.auth0IdToken && { id_token: authCodeData.auth0IdToken }),
        // Include refresh_token if available
        ...(authCodeData.auth0RefreshToken && { refresh_token: authCodeData.auth0RefreshToken }),
      };

      console.log('Token exchange successful');

      return addCorsHeaders(new Response(JSON.stringify(tokenResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // ============================================
    // Health Check Endpoint
    // ============================================
    if (url.pathname === '/health') {
      return addCorsHeaders(new Response(JSON.stringify({
        status: 'healthy',
        service: 'Fianu Compliance Intelligence MCP',
        version: env.MCP_SERVER_VERSION,
        environment: env.ENVIRONMENT,
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // ============================================
    // MCP SSE Endpoint (Protected)
    // ============================================
    if (url.pathname === '/sse' || (url.pathname.startsWith('/sse/') && !url.pathname.includes('.well-known'))) {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // Return 401 with WWW-Authenticate header per OAuth spec (RFC 9728)
        // The resource_metadata URL tells clients where to find protected resource metadata
        // which then points to the authorization server
        const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
        
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_token',
          error_description: 'Missing or invalid Authorization header',
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        }));
      }

      const token = authHeader.substring(7);

      // Validate Auth0 JWT token
      const auth0 = new Auth0Handler(env);
      try {
        const claims = await auth0.validateToken(token);
        const userId = Auth0Handler.extractUserId(claims);
        const tenantId = Auth0Handler.extractTenantId(claims);

        console.log('Authentication successful:', {
          userId,
          tenantId,
          userEmail: Auth0Handler.extractUserEmail(claims),
        });

        // Get or create Durable Object for this user's MCP session
        const id = env.COMPLIANCE_MCP.idFromName(userId);
        const stub = env.COMPLIANCE_MCP.get(id);

        // Initialize session state
        await stub.fetch(new Request('https://internal/set-session', {
          method: 'POST',
          body: JSON.stringify({
            userId,
            tenantId,
            accessToken: token,
            tokenExpiry: claims.exp,
            userEmail: Auth0Handler.extractUserEmail(claims),
            userName: Auth0Handler.extractUserName(claims),
            sessionStarted: Date.now(),
          }),
        }));

        // Forward the MCP request to the Durable Object
        const doResponse = await stub.fetch(request);
        
        // Safety check - ensure we got a valid response
        if (!doResponse) {
          console.error('Durable Object returned null/undefined response');
          return addCorsHeaders(new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: 'Internal error',
              data: 'Durable Object returned no response',
            },
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        
        return addCorsHeaders(doResponse);
      } catch (error) {
        console.error('Authentication failed:', error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        const isExpired = errorMessage.toLowerCase().includes('expired');

        const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
        
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'invalid_token',
          error_description: isExpired ? 'Token has expired' : 'Invalid token',
          details: errorMessage,
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
          },
        }));
      }
    }

    // ============================================
    // Default Response (API Info)
    // ============================================
    return addCorsHeaders(new Response(JSON.stringify({
      name: env.MCP_SERVER_NAME,
      version: env.MCP_SERVER_VERSION,
      description: 'AI-powered compliance intelligence for your software supply chain',
      authentication: 'OAuth 2.0 Authorization Code Flow with PKCE',
      endpoints: {
        health: '/health',
        discovery: '/.well-known/oauth-authorization-server',
        register: 'POST /register',
        authorize: 'GET /authorize',
        token: 'POST /token',
        mcp: '/sse (requires Bearer token)',
      },
      documentation: 'https://docs.fianu.io/mcp/compliance-intelligence',
    }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  },
};

/**
 * Generate PKCE code challenge from code verifier
 */
async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  
  // Base64url encode
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Add CORS headers to response
 */
function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Export Durable Object class
export { ComplianceMCP };
