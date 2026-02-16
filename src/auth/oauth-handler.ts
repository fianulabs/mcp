/**
 * OAuth Handler for Auth0 Integration
 * 
 * This handler implements the third-party OAuth provider flow as described in:
 * https://developers.cloudflare.com/agents/model-context-protocol/authorization/
 * 
 * Flow:
 * 1. MCP client calls /authorize on this server
 * 2. This server redirects to Auth0 for authentication
 * 3. Auth0 redirects back to /callback with an authorization code
 * 4. This server exchanges the code for Auth0 tokens
 * 5. This server generates its own MCP token and completes the OAuth flow
 */

import type { Env } from '../types';

interface OAuthState {
  mcpRedirectUri: string;
  mcpCodeChallenge: string;
  mcpCodeChallengeMethod: string;
  mcpState: string;
  mcpClientId: string;
}

/**
 * AuthHandler implements the Cloudflare Workers OAuth Provider pattern
 * for third-party OAuth (Auth0) integration
 */
export class AuthHandler {
  constructor(private env: Env) {}

  /**
   * Handle all authentication-related requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    console.log('AuthHandler.fetch:', {
      method: request.method,
      pathname: url.pathname,
    });

    // Handle authorization request - redirect to Auth0
    if (url.pathname === '/authorize') {
      return this.handleAuthorize(request, baseUrl);
    }

    // Handle callback from Auth0
    if (url.pathname === '/callback') {
      return this.handleCallback(request, baseUrl);
    }

    // Handle login page (optional - can show a custom login UI)
    if (url.pathname === '/login') {
      return this.handleLogin(request, baseUrl);
    }

    // Not an auth endpoint
    return new Response('Not Found', { status: 404 });
  }

  /**
   * Handle /authorize - Start the OAuth flow by redirecting to Auth0
   */
  private async handleAuthorize(request: Request, baseUrl: string): Promise<Response> {
    const url = new URL(request.url);

    // Extract MCP client's OAuth parameters
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const responseType = url.searchParams.get('response_type');
    const scope = url.searchParams.get('scope');
    const state = url.searchParams.get('state');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');

    console.log('Authorize request:', {
      clientId,
      redirectUri,
      responseType,
      scope,
      state: state?.substring(0, 20) + '...',
      codeChallenge: codeChallenge?.substring(0, 20) + '...',
      codeChallengeMethod,
    });

    // Validate required parameters
    if (!redirectUri || !state) {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing required parameters: redirect_uri, state',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Store the MCP client's OAuth parameters so we can complete the MCP flow after Auth0
    // This includes PKCE parameters (code_challenge) and the redirect_uri to send the final code to
    const oauthState: OAuthState = {
      mcpRedirectUri: redirectUri,
      mcpCodeChallenge: codeChallenge || '',
      mcpCodeChallengeMethod: codeChallengeMethod || 'S256', // SHA-256 for PKCE
      mcpState: state,
      mcpClientId: clientId || '',
    };

    // Generate a unique state parameter for the Auth0 request (separate from MCP state)
    // This prevents CSRF attacks on the Auth0 callback
    const auth0State = crypto.randomUUID();

    // Store the MCP OAuth state in KV, keyed by our Auth0 state parameter
    // We'll retrieve this in the callback to complete the MCP OAuth flow
    await this.env.CACHE_KV.put(
      `oauth_state:${auth0State}`,
      JSON.stringify(oauthState),
      { expirationTtl: 600 } // 10 minute expiry - OAuth flows should complete quickly
    );

    // Build Auth0 authorization URL with all required parameters
    const auth0Domain = this.env.AUTH0_DOMAIN;
    const auth0ClientId = this.env.AUTH0_CLIENT_ID;
    const auth0Audience = this.env.AUTH0_AUDIENCE;
    const auth0Organization = this.env.AUTH0_ORGANIZATION;

    const auth0AuthUrl = new URL(`https://${auth0Domain}/authorize`);
    auth0AuthUrl.searchParams.set('response_type', 'code'); // Authorization Code flow
    auth0AuthUrl.searchParams.set('client_id', auth0ClientId);
    auth0AuthUrl.searchParams.set('redirect_uri', `${baseUrl}/callback`);
    auth0AuthUrl.searchParams.set('scope', 'openid profile email'); // Standard OIDC scopes
    auth0AuthUrl.searchParams.set('state', auth0State); // Our state for CSRF protection

    // Audience parameter tells Auth0 which API we're requesting access to
    // This is required to get an access token (not just an ID token)
    if (auth0Audience) {
      auth0AuthUrl.searchParams.set('audience', auth0Audience);
    }

    // Organization parameter enables multi-tenant Auth0 setup
    // Each tenant/customer can have their own organization
    if (auth0Organization) {
      auth0AuthUrl.searchParams.set('organization', auth0Organization);
    }

    console.log('Redirecting to Auth0:', auth0AuthUrl.toString());

    // Redirect to Auth0
    return Response.redirect(auth0AuthUrl.toString(), 302);
  }

  /**
   * Handle /callback - Process Auth0's response and complete the MCP OAuth flow
   */
  private async handleCallback(request: Request, baseUrl: string): Promise<Response> {
    const url = new URL(request.url);

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    console.log('Callback received:', {
      hasCode: !!code,
      state: state?.substring(0, 20) + '...',
      error,
    });

    // Handle Auth0 errors
    if (error) {
      console.error('Auth0 returned error:', error, errorDescription);
      return new Response(`
        <html>
          <body>
            <h1>Authentication Failed</h1>
            <p>Error: ${error}</p>
            <p>${errorDescription || ''}</p>
          </body>
        </html>
      `, {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    if (!code || !state) {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Missing code or state from Auth0',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Retrieve the MCP OAuth state we stored in handleAuthorize()
    // This contains the MCP client's redirect_uri and PKCE parameters
    const storedStateJson = await this.env.CACHE_KV.get(`oauth_state:${state}`);
    if (!storedStateJson) {
      console.error('OAuth state not found or expired');
      return new Response(JSON.stringify({
        error: 'invalid_state',
        error_description: 'OAuth state not found or expired. Please try again.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const oauthState: OAuthState = JSON.parse(storedStateJson);

    // Clean up the stored state (one-time use only, prevents replay attacks)
    await this.env.CACHE_KV.delete(`oauth_state:${state}`);

    // Exchange the Auth0 authorization code for Auth0 access token
    // This is the standard OAuth 2.0 authorization code exchange
    const auth0Domain = this.env.AUTH0_DOMAIN;
    const auth0TokenUrl = `https://${auth0Domain}/oauth/token`;

    const tokenRequestBody = {
      grant_type: 'authorization_code',
      client_id: this.env.AUTH0_CLIENT_ID,
      client_secret: this.env.AUTH0_CLIENT_SECRET,
      code: code,
      redirect_uri: `${baseUrl}/callback`,
    };

    console.log('Exchanging code for token with Auth0...');

    const tokenResponse = await fetch(auth0TokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tokenRequestBody),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      console.error('Auth0 token exchange failed:', tokenResponse.status, errorBody);
      return new Response(`
        <html>
          <body>
            <h1>Authentication Failed</h1>
            <p>Failed to exchange authorization code for token.</p>
            <p>Please try again.</p>
          </body>
        </html>
      `, {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const auth0Tokens = await tokenResponse.json() as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    console.log('Auth0 token exchange successful');

    // TWO-STEP OAUTH DANCE:
    // 1. We just exchanged Auth0's code for Auth0 tokens
    // 2. Now we generate our own MCP authorization code to send to the MCP client
    // 3. The MCP client will exchange OUR code for OUR tokens at /token endpoint
    //
    // This allows us to act as an OAuth provider while using Auth0 as the identity source
    const mcpAuthCode = crypto.randomUUID();

    // Store the Auth0 tokens + MCP PKCE parameters associated with this MCP auth code
    // The /token endpoint will:
    // - Verify the PKCE code_verifier matches the stored code_challenge
    // - Return the Auth0 tokens to the MCP client
    // - This completes the OAuth flow
    await this.env.CACHE_KV.put(
      `mcp_auth_code:${mcpAuthCode}`,
      JSON.stringify({
        auth0AccessToken: auth0Tokens.access_token,
        auth0IdToken: auth0Tokens.id_token,
        auth0RefreshToken: auth0Tokens.refresh_token,
        auth0ExpiresIn: auth0Tokens.expires_in,
        mcpCodeChallenge: oauthState.mcpCodeChallenge, // For PKCE verification
        mcpCodeChallengeMethod: oauthState.mcpCodeChallengeMethod,
        mcpClientId: oauthState.mcpClientId,
        mcpRedirectUri: oauthState.mcpRedirectUri,
        createdAt: Date.now(),
      }),
      { expirationTtl: 300 } // 5 minute expiry - auth codes are short-lived (RFC 6749)
    );

    // Redirect back to the MCP client's redirect_uri with OUR authorization code
    // The MCP client will now call our /token endpoint to exchange this code for tokens
    const mcpRedirectUrl = new URL(oauthState.mcpRedirectUri);
    mcpRedirectUrl.searchParams.set('code', mcpAuthCode); // Our MCP auth code
    mcpRedirectUrl.searchParams.set('state', oauthState.mcpState); // Echo back their state

    console.log('Redirecting to MCP client:', mcpRedirectUrl.toString());

    return Response.redirect(mcpRedirectUrl.toString(), 302);
  }

  /**
   * Handle /login - Optional custom login page
   */
  private async handleLogin(request: Request, baseUrl: string): Promise<Response> {
    // You can customize this to show a branded login page before redirecting to Auth0
    const url = new URL(request.url);
    const returnTo = url.searchParams.get('return_to') || '/';

    return new Response(`
      <html>
        <head>
          <title>Login - Fianu Compliance Intelligence</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 8px;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
              text-align: center;
              max-width: 400px;
            }
            h1 { color: #333; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 30px; }
            .btn {
              display: inline-block;
              background: #667eea;
              color: white;
              padding: 12px 24px;
              border-radius: 4px;
              text-decoration: none;
              font-weight: 500;
            }
            .btn:hover { background: #5a67d8; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Fianu Compliance Intelligence</h1>
            <p>Sign in to access compliance tools for your AI assistant.</p>
            <a href="${returnTo}" class="btn">Sign in with Auth0</a>
          </div>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

