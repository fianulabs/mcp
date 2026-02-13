# Deployment Plan

This document outlines the steps required to promote the MCP Compliance Intelligence server from staging to production.

---

## Current State

| Environment | Worker Name | URL | Status |
|-------------|-------------|-----|--------|
| Staging | `mcp-compliance-intelligence-staging` | `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse` | Active |
| Production | `mcp-compliance-intelligence` | TBD | Not deployed |

---

## 1. Infrastructure Configuration

### Cloudflare Resources

| Resource | Staging | Production |
|----------|---------|------------|
| Worker Name | `mcp-compliance-intelligence-staging` | `mcp-compliance-intelligence` |
| KV Namespace | `5f03055ed9f741f9b0bde029a7cc9f6f` | **New namespace required** |
| Durable Objects | Staging storage | Separate production storage |
| Analytics Engine | Shared | Consider separate dataset |

### Create Production KV Namespace

```bash
npx wrangler kv:namespace create CACHE_KV --env production
```

Copy the returned namespace ID for use in `wrangler.toml`.

---

## 2. Configuration Updates

### Update `wrangler.toml`

The production environment section needs to be completed:

```toml
[env.production]
name = "mcp-compliance-intelligence"

[[env.production.durable_objects.bindings]]
name = "COMPLIANCE_MCP"
class_name = "ComplianceMCP"

[[env.production.kv_namespaces]]
binding = "CACHE_KV"
id = "<PRODUCTION_KV_NAMESPACE_ID>"

[[env.production.analytics_engine_datasets]]
binding = "ANALYTICS"

[env.production.vars]
ENVIRONMENT = "production"
CONSULTA_URL = "https://consulta.fianu.io/api"
AUTH0_DOMAIN = "auth.fianu.io"
AUTH0_ISSUER = "<PRODUCTION_AUTH0_ISSUER>"
AUTH0_AUDIENCE = "<PRODUCTION_AUTH0_AUDIENCE>"
MCP_SERVER_NAME = "Fianu Compliance Intelligence"
MCP_SERVER_VERSION = "0.1.0"
```

### Set Production Secrets

```bash
npx wrangler secret put AUTH0_CLIENT_ID --env production
# Paste production client ID when prompted

npx wrangler secret put AUTH0_CLIENT_SECRET --env production
# Paste production client secret when prompted
```

---

## 3. Auth0 Configuration

### Verify Production Auth0 Application

Confirm the following in the Auth0 dashboard:
- Client ID and Secret for production
- Correct issuer URL
- Correct audience

### Add Callback URLs

Add these URLs to the Auth0 application's allowed callback URLs:

**Workers.dev domain:**
- `https://mcp-compliance-intelligence.noah-684.workers.dev/callback`
- `https://mcp-compliance-intelligence.noah-684.workers.dev/token`

**Custom domain (if configured):**
- `https://mcp.fianu.io/callback`
- `https://mcp.fianu.io/token`

---

## 4. Custom Domain (Optional)

For a production-ready URL like `mcp.fianu.io`:

1. Add DNS record in Cloudflare pointing to the worker
2. Configure custom domain in Cloudflare Workers dashboard
3. Update Auth0 callback URLs
4. Update documentation with new URL

---

## 5. Deployment

### Add Production Deploy Script

Verify `package.json` includes:

```json
{
  "scripts": {
    "deploy:production": "wrangler deploy --env production"
  }
}
```

### Deploy to Production

```bash
npm run deploy:production
```

---

## 6. Pre-Production Checklist

Complete these items before deploying to production:

| Item | Owner | Status |
|------|-------|--------|
| Create production KV namespace | | |
| Update `wrangler.toml` with production KV ID | | |
| Verify production Auth0 credentials | | |
| Set AUTH0_CLIENT_ID secret (production) | | |
| Set AUTH0_CLIENT_SECRET secret (production) | | |
| Confirm production Consulta URL | | |
| Add Auth0 callback URLs | | |
| Update README with production URL | | |
| Update CLAUDE_DESKTOP_SETUP.md | | |
| Update CURSOR_SETUP.md | | |
| Run smoke tests on production | | |

---

## 7. Post-Deployment Verification

### Health Check

```bash
curl https://mcp-compliance-intelligence.noah-684.workers.dev/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "Fianu Compliance Intelligence MCP",
  "version": "0.1.0",
  "environment": "production"
}
```

### OAuth Flow Test

```bash
# Register a client
REG=$(curl -s -X POST https://mcp-compliance-intelligence.noah-684.workers.dev/register)
CLIENT_ID=$(echo "$REG" | jq -r .client_id)
CLIENT_SECRET=$(echo "$REG" | jq -r .client_secret)

# Get token
TOKEN=$(curl -s -X POST https://mcp-compliance-intelligence.noah-684.workers.dev/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" | jq -r .access_token)

# Verify token works
curl https://mcp-compliance-intelligence.noah-684.workers.dev/sse \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: text/event-stream"
```

### Tool Verification

Connect via Claude Desktop or Cursor and verify:
- [ ] `get_compliance_summary` returns data
- [ ] `get_asset_compliance_status` works for a known asset
- [ ] `list_controls` returns controls

---

## 8. Rollback Plan

If issues arise after production deployment:

### List Recent Deployments

```bash
npx wrangler deployments list --env production
```

### Rollback to Previous Version

```bash
npx wrangler rollback --env production
```

### Emergency: Disable Worker

If critical issues occur, the worker can be disabled from the Cloudflare dashboard.

---

## 9. Monitoring

### Cloudflare Dashboard

Monitor these metrics in the Cloudflare Workers dashboard:
- Request count
- Error rate
- CPU time
- Duration (p50, p99)

### View Logs

```bash
npx wrangler tail --env production
```

### Analytics Engine Queries

Audit logs can be queried via Cloudflare Analytics Engine:

```sql
-- Recent tool invocations
SELECT
  blob2 as tool_name,
  blob3 as user_id,
  COUNT(*) as invocations
FROM analytics_engine_compliance_mcp
WHERE blob1 = 'mcp_tool_invocation'
  AND timestamp >= NOW() - INTERVAL '1 hour'
GROUP BY blob2, blob3;
```

---

## 10. CI/CD Pipeline (Future)

Recommended GitHub Actions workflow:

| Trigger | Action |
|---------|--------|
| Push to `main` | Deploy to staging |
| Release tag (`v*`) | Deploy to production |

This ensures:
- All changes go through staging first
- Production deploys are explicit via tags
- Tests run before any deployment

---

## Key Decisions Required

Before production deployment, confirm:

1. **Auth0 credentials** - Use existing production app or create new one?
2. **Custom domain** - Deploy to workers.dev or set up custom domain?
3. **DEFAULT_TENANT_ID** - Keep for fallback or remove for stricter multi-tenancy?
4. **CI/CD** - Implement automated pipeline or continue manual deploys?

---

## Support

- **Implementation Plan**: `/eng-specs/compliance-intelligence-mcp/implementation-plan.md`
- **Issues**: Contact Pete Zimmerman or file in Fianu repo








