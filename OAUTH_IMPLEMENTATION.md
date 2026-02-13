# OAuth 2.0 Implementation

## Overview

The MCP server implements OAuth 2.0 Authorization Code Flow with PKCE, using Auth0 as the identity provider. The server acts as its **own OAuth provider** while delegating authentication to Auth0.

This follows the [Cloudflare MCP Authorization pattern](https://developers.cloudflare.com/agents/model-context-protocol/authorization/) for third-party OAuth providers.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  MCP Client │     │  MCP Server │     │    Auth0    │
│ (mcp-remote)│     │  (Worker)   │     │             │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │ 1. GET /authorize │                   │
       │──────────────────>│                   │
       │                   │                   │
       │                   │ 2. Redirect to    │
       │                   │    Auth0/authorize│
       │<──────────────────│──────────────────>│
       │                   │                   │
       │                   │                   │ 3. User logs in
       │                   │                   │
       │                   │ 4. Callback with  │
       │                   │    auth code      │
       │                   │<──────────────────│
       │                   │                   │
       │                   │ 5. Exchange code  │
       │                   │    for token      │
       │                   │──────────────────>│
       │                   │<──────────────────│
       │                   │                   │
       │ 6. Redirect with  │                   │
       │    MCP auth code  │                   │
       │<──────────────────│                   │
       │                   │                   │
       │ 7. POST /token    │                   │
       │──────────────────>│                   │
       │                   │                   │
       │ 8. Access token   │                   │
       │<──────────────────│                   │
       │                   │                   │
       │ 9. MCP requests   │                   │
       │   with Bearer     │                   │
       │──────────────────>│                   │
```

## Endpoints

### 1. Discovery Endpoint
**GET** `/.well-known/oauth-authorization-server`

Returns OAuth 2.0 discovery metadata (RFC 8414):

```json
{
  "issuer": "https://mcp-compliance-intelligence.workers.dev",
  "authorization_endpoint": "https://mcp-compliance-intelligence.workers.dev/authorize",
  "token_endpoint": "https://mcp-compliance-intelligence.workers.dev/token",
  "registration_endpoint": "https://mcp-compliance-intelligence.workers.dev/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
  "scopes_supported": ["openid", "profile", "email"]
}
```

**Important**: All endpoints point to the MCP server (not Auth0 directly).

### 2. Registration Endpoint
**POST** `/register`

Dynamically registers an OAuth client:

```json
{
  "client_id": "mcp_abc123def456",
  "client_id_issued_at": 1701234567,
  "redirect_uris": ["http://localhost:9935/oauth/callback"],
  "response_types": ["code"],
  "grant_types": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_method": "none",
  "application_type": "native"
}
```

### 3. Authorization Endpoint
**GET** `/authorize`

Initiates the OAuth flow. Parameters:
- `client_id` - Client ID from registration
- `redirect_uri` - Where to redirect after auth
- `response_type` - Must be `code`
- `state` - CSRF protection token
- `code_challenge` - PKCE challenge
- `code_challenge_method` - Must be `S256`
- `scope` - Requested scopes

Redirects to Auth0 for user authentication.

### 4. Callback Endpoint
**GET** `/callback`

Handles the callback from Auth0 after user authentication:
1. Exchanges Auth0 authorization code for tokens
2. Stores tokens in KV
3. Generates MCP authorization code
4. Redirects to MCP client's redirect_uri

### 5. Token Endpoint
**POST** `/token`

Exchanges the MCP authorization code for an access token:

**Request** (form-encoded or JSON):
```
grant_type=authorization_code
code=<mcp_auth_code>
code_verifier=<pkce_verifier>
redirect_uri=http://localhost:9935/oauth/callback
```

**Response**:
```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 86400,
  "scope": "openid profile email",
  "id_token": "<jwt>"
}
```

### 6. MCP SSE Endpoint
**POST** `/sse`

Protected MCP endpoint. Requires `Authorization: Bearer <access_token>` header.

## Testing

### 1. Test Discovery Endpoint
```bash
curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/.well-known/oauth-authorization-server | jq
```

Expected: JSON with `issuer`, `authorization_endpoint`, `token_endpoint` all pointing to the MCP server.

### 2. Test Registration
```bash
curl -X POST https://mcp-compliance-intelligence-staging.noah-684.workers.dev/register | jq
```

Expected: JSON with `client_id`.

### 3. Test with mcp-remote
```bash
npx mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse
```

This should:
1. Fetch discovery document
2. Register a client
3. Open browser for Auth0 login
4. Exchange tokens after login
5. Connect to MCP server

### 4. Test in Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "fianu-compliance": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse"
      ]
    }
  }
}
```

## Auth0 Configuration

### Required Settings
1. **Application Type**: Regular Web Application
2. **Allowed Callback URLs**: 
   - `https://mcp-compliance-intelligence.workers.dev/callback`
   - `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/callback`
3. **Allowed Logout URLs**: (if using logout)
4. **Token Endpoint Authentication Method**: Post

### Required Secrets
Set via `wrangler secret put`:
- `AUTH0_CLIENT_ID` - Your Auth0 application's client ID
- `AUTH0_CLIENT_SECRET` - Your Auth0 application's client secret

### Environment Variables
In `wrangler.toml`:
- `AUTH0_DOMAIN` - Your Auth0 domain (e.g., `auth.fianu.io` or `dev-xxx.us.auth0.com`)
- `AUTH0_ISSUER` - Auth0 issuer URL (e.g., `https://dev-xxx.us.auth0.com/`)
- `AUTH0_AUDIENCE` - API audience (optional)

## Troubleshooting

### "ZodError - issuer, authorization_endpoint undefined"
The discovery endpoint is returning an invalid response. Test with:
```bash
curl -v https://your-server/sse/.well-known/oauth-authorization-server
```

### "Invalid redirect_uri"
Make sure the callback URL is registered in Auth0:
- Go to Auth0 Dashboard → Applications → Your App → Settings
- Add `https://your-worker.workers.dev/callback` to Allowed Callback URLs

### "Token exchange failed"
Check Auth0 logs for the error. Common issues:
- Wrong client_secret
- Authorization code expired (codes expire quickly)
- Redirect URI mismatch

### Debugging
Watch worker logs in real-time:
```bash
npx wrangler tail --env staging
```

## Security Considerations

1. **PKCE**: All authorization requests should use PKCE (code_challenge/code_verifier)
2. **State Parameter**: Used to prevent CSRF attacks
3. **Short-lived Auth Codes**: Authorization codes expire in 5 minutes
4. **Token Validation**: All tokens are validated against Auth0's JWKS
5. **Tenant Isolation**: User's tenant is extracted from JWT claims

## Key Implementation Files

- `src/index.ts` - Main entry point, OAuth endpoints
- `src/auth/oauth-handler.ts` - Auth0 authorization flow handler
- `src/auth/auth0-handler.ts` - JWT validation and claims extraction
- `src/compliance-mcp.ts` - MCP server (Durable Object)
