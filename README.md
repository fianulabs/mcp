# Fianu Compliance Intelligence MCP Server

AI-powered compliance intelligence for your software supply chain. This Model Context Protocol (MCP) server enables AI assistants like Claude Desktop to query Fianu's compliance data in natural language.

## Features

### MCP Tools

| Tool | Description | Example Question |
|------|-------------|------------------|
| **`get_asset_compliance_status`** | Get compliance status for a specific asset with all passing/failing controls | *"What is the compliance status of my-repo?"* |
| **`list_controls`** | List all compliance controls with filtering by severity or framework | *"What controls do we have?"* |
| **`get_compliance_summary`** | Executive-level organization-wide compliance overview with risk categorization | *"How healthy is my compliance posture right now?"* |
| **`get_attestation_details`** | Get attestation details - supports org-wide (control only) or asset-specific queries | *"Show me pass/fail status for cycode.secret.detection across all repos"* |
| **`get_deployment_attestations`** | Show all attestations from a specific deployment record | *"Show me attestations from the last deployment of my-app"* |
| **`get_pipeline_vulnerabilities`** | Get security vulnerabilities from pipeline scans (SAST, SCA, secrets, container) | *"What vulnerabilities were found in my-repo?"* |
| **`get_evidence_chain`** | Trace evidence lineage from origin through occurrences to attestations | *"Show me the evidence chain for the secret detection failure in my-repo"* |
| **`get_policy_violations`** | Get failing controls as "policy violations" across the org or for a specific asset | *"What are all the policy violations?"* or *"Which assets are failing secret detection?"* |
| **`get_compliance_trends`** | Analyze compliance trends over time using smart sampling | *"How has compliance changed over the last 30 days?"* or *"Is my compliance improving?"* |
| **`get_deployment_blockers`** | Find what's blocking an application from deploying to a specific gate/environment | *"What's blocking DBX from deploying to production?"* or *"Can my-app deploy to staging?"* |
| **`get_policy_exceptions`** | List and analyze policy exceptions (waivers/exemptions from controls) | *"What policy exceptions are active?"* or *"Which controls have exceptions?"* |
| **`resolve_external_artifact`** | Resolve artifact URI from Artifactory/container registries to Fianu dashboard | *"Take me to Fianu for sha256:abc123..."* or *"Find Fianu dashboard for this container image"* |
| **`analyze_control_failure`** | Analyze OPA Rego policy for a control to understand what it checks and why it fails | *"Why is cycode.secret.detection failing?"* or *"Show me the OPA Rego for dependabot.alerts"* |
| **`list_releases`** | List upcoming (pending) or past (released) releases for an application | *"What are the upcoming releases for DBX?"* or *"Show me the last 5 releases for Digital Banking Experience"* |

### Security

- **OAuth 2.0** authentication via Auth0
- **Tenant isolation** - Users can only access their own organization's data
- **Audit logging** - All API calls and tool invocations logged to Cloudflare Analytics Engine
- **JWT validation** - Cryptographically verifies all tokens

### Technology Stack

- **Cloudflare Workers** - Serverless runtime
- **Durable Objects** - Stateful MCP sessions
- **KV Namespace** - Response caching
- **Analytics Engine** - Audit trail and monitoring
- **TypeScript** - Type-safe development

---

## Prerequisites

- Node.js 18+ and npm
- Cloudflare account (Account ID: `6841d88809021dab1138d0451d92f94e`)
- Auth0 credentials (Client ID & Secret from fianu.io application)
- Access to Fianu Dev environment

---

## Setup

### 1. Clone and Install

```bash
cd /Users/petezimmerman/Documents/dev/mcp-compliance-intelligence
npm install
```

### 2. Configure Cloudflare

The `wrangler.toml` file is already configured with:
- Account ID
- Worker name
- Durable Object bindings
- KV namespace binding (needs creation)
- Analytics Engine binding

### 3. Create KV Namespace

```bash
npx wrangler kv:namespace create CACHE_KV
```

Copy the namespace ID and update `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "CACHE_KV"
id = "<paste-namespace-id-here>"
```

### 4. Set Secrets

Set Auth0 credentials (get these from the fianu.io Auth0 application):

```bash
npx wrangler secret put AUTH0_CLIENT_ID
# Paste client ID when prompted

npx wrangler secret put AUTH0_CLIENT_SECRET
# Paste client secret when prompted

# Optional: Set audience if Consulta requires it
npx wrangler secret put AUTH0_AUDIENCE
# Enter: https://fianu.io/api
```

### 5. Configure Auth0 Application

In the Auth0 dashboard for the fianu.io application, add these callback URLs:
- `https://noah-684.workers.dev/mcp-compliance-intelligence/callback`
- `https://noah-684.workers.dev/mcp-compliance-intelligence/token`
- `http://localhost:8788/callback` (for local testing)
- `http://localhost:8788/token` (for local testing)

---

## Using the MCP Server

The Fianu Compliance Intelligence MCP server works with both **Claude Desktop** and **Cursor IDE** using the same configuration. The server uses OAuth 2.0 for authentication, so no manual token setup is required.

### MCP Server URL

**Production**: `https://mcp.fianu.io/sse`

**Staging**: `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

### Configuration for Claude Desktop

Add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fianu-compliance": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse"
      ]
    }
  }
}
```

After adding the configuration:
1. **Restart Claude Desktop** completely
2. Claude Desktop will automatically:
   - Register an ephemeral client via `/register`
   - Exchange it for a token via `/token`
   - Connect to `/sse` with `Authorization: Bearer <token>`
3. Try asking: "What compliance tools are available?" or "Get compliance status for asset xd-trading-app"

### Configuration for Cursor IDE

Cursor uses the same JSON configuration file format as Claude Desktop. Add this to your Cursor MCP configuration file:

**macOS/Linux**: `~/.cursor/mcp.json`  
**Windows**: `%APPDATA%\Cursor\mcp.json`

```json
{
  "mcpServers": {
    "fianu-compliance": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse"
      ]
    }
  }
}
```

After adding the configuration:
1. **Restart Cursor** completely
2. Cursor will automatically:
   - Register an ephemeral client via `/register`
   - Exchange it for a token via `/token`
   - Connect to `/sse` with `Authorization: Bearer <token>`
3. The MCP server should appear as "Connected" in Cursor's MCP panel
4. Available tools will appear in the MCP tools list

**Alternative: UI Configuration**

You can also configure via Cursor's UI:
1. Open Settings (`Cmd/Ctrl + ,`) > `Features` > `MCP`
2. Click `+ Add New MCP Server`
3. Configure:
   - **Name**: `Fianu Compliance Intelligence`
   - **Type**: `stdio`
   - **Command**: `npx`
   - **Args**: `-y`, `mcp-remote`, `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

### Available Tools

Once connected, these tools are available in both Claude Desktop and Cursor:

#### `get_asset_compliance_status`
Get compliance status for a specific asset. Returns compliance score, all controls (passing/failing/missing), and actionable recommendations.
- **Parameters**: `assetIdentifier` (required), `assetType`, `branch`
- **Example**: *"What is the compliance status of fianu-fullstack-demo?"*

#### `list_controls`
List all compliance controls configured in the organization. Use this to discover available control paths.
- **Parameters**: `severity`, `framework`
- **Example**: *"Show me all critical controls"* or *"What controls do we have for SOC2?"*

#### `get_compliance_summary`
Executive-level organization-wide compliance overview for CISO reporting.
- **Returns**: Risk level (CRITICAL/HIGH/MEDIUM/LOW), asset breakdown by type, top failing controls, riskiest assets, and recommendations
- **Parameters**: `frameworkFilter`, `includeAssets`
- **Example**: *"How healthy is my compliance posture right now?"*

#### `get_attestation_details`
**Two modes of operation:**
1. **Org-wide mode** (controlPath only): Shows pass/fail status across ALL assets for a control
2. **Asset-specific mode** (with assetIdentifier): Shows detailed attestation info including thresholds and measured values
- **Parameters**: `controlPath`, `assetIdentifier`, `attestationUuid`, `branch`, `commit`
- **Example**: *"Show me cycode.secret.detection status across all repos"* or *"Get attestation details for sonarqube.codescan.coverage on my-repo"*

#### `get_deployment_attestations`
Show all attestations from a specific deployment record (not policy compliance).
- **Parameters**: `assetIdentifier` (required), `deploymentId`, `environment`
- **Example**: *"Show me attestations from the last deployment of my-app to PROD"*

#### `get_pipeline_vulnerabilities`
Get all vulnerabilities from security scans (SAST, SCA, secrets, container) for a repository.
- **Parameters**: `assetIdentifier` (required), `branch`, `commit`, `severity`, `showIntroduced`
- **Special**: Use `showIntroduced=true` to see only NEW vulnerabilities compared to the previous commit
- **Example**: *"What security vulnerabilities were found in fianu-fullstack-demo?"* or *"Show me critical vulnerabilities introduced by the last commit"*

#### `get_evidence_chain`
Trace the evidence chain (lineage) for a note, attestation, or commit. Shows how evidence flows from origin (trigger) through occurrences (data collection) to attestations (control evaluations).

**Three modes of operation:**
1. **Direct UUID**: Provide `noteUuid` to trace a specific note
2. **Asset + Commit**: Provide `assetIdentifier` + `commit` for a specific commit
3. **Asset Only**: Provide just `assetIdentifier` - auto-resolves to latest commit on default branch

**Parameters:**
- `noteUuid` - UUID of a specific note (attestation, occurrence, or transaction)
- `assetIdentifier` - Asset/repo name (e.g., "fianu-fullstack-demo")
- `commit` - Specific commit SHA (full or short)
- `branch` - Branch name (defaults to default branch)
- `controlPath` - Filter for specific control (e.g., "secret.detection")
- `direction` - `upstream` (ancestors), `downstream` (children), or `full` (both)
- `maxDepth` - Maximum traversal depth (default: 10)

**Example questions:**
- *"Show me the evidence chain for the secret detection failure in fianu-fullstack-demo"*
- *"What led to this deployment decision?"*
- *"What evidence was generated from the last build?"*

#### `get_policy_violations`
Get policy violations (failing controls) across the organization or for a specific asset. This tool surfaces failing attestations as "policy violations" - a first-class concept for compliance monitoring.

**Parameters:**
- `assetIdentifier` - Optional - filter to a specific asset (name or UUID)
- `controlPath` - Optional - filter to a specific control (e.g., "cycode.secret.detection")
- `severity` - Optional - filter by severity level (critical, high, medium, low)
- `since` - Optional - only show violations since this date (ISO 8601 format)
- `limit` - Optional - maximum violations to return (default 100, max 500)

**Returns:** Violation count, risk level, violations grouped by control, and actionable recommendations.

**Example questions:**
- *"What are all the policy violations?"*
- *"Which assets are failing secret detection?"*
- *"Show me critical control failures"*
- *"What violations have occurred in the last week?"*

#### `get_compliance_trends`
Analyze compliance trends over time using smart sampling. Shows how compliance has changed and which controls have improved or declined.

**Parameters:**
- `assetIdentifier` - Optional - filter to a specific asset (name or UUID). Omit for org-wide trends.
- `period` - Time period to analyze: "7d" (7 days), "30d" (30 days, default), "90d" (90 days)

**Returns:**
- Summary with current score, period start score, trend direction (improving/stable/declining), change percent
- Highlights showing most improved and most declined controls
- Sampled data points (max 30 for performance)
- Insights and recommendations

**Example questions:**
- *"How has compliance changed over the last 30 days?"*
- *"Is my compliance improving or declining?"*
- *"What controls have improved the most?"*
- *"Show me the 90-day compliance trajectory"*

**Note:** Uses smart sampling to ensure fast responses. For exact point-in-time data, use `get_policy_violations` with a specific date.

#### `get_deployment_blockers`
Find what's blocking an application from deploying to a specific environment/gate. This tool checks all assets in an application against gate requirements and reports which controls are failing.

**Parameters:**
- `applicationName` - REQUIRED - Application name or code (e.g., "DBX", "Digital Banking Experience")
- `targetEnvironment` - Optional - Target gate/environment (default: "production"). Examples: "staging", "qa", "prod"

**Returns:**
- Application info (resolved name, code, uuid)
- Target gate info
- `canDeploy` boolean - true if all required controls pass
- Blocked assets with failing controls and reasons
- Passing assets
- Insights and recommendations

**Example questions:**
- *"What's blocking DBX from deploying to production?"*
- *"Can Digital Banking Experience deploy to staging?"*
- *"Why can't fianu-fullstack-demo release?"*
- *"Is my-app ready to deploy?"*

**Note:** This tool checks current compliance state. For historical deployment records, use `get_deployment_attestations`.

#### `get_policy_exceptions`
List and analyze policy exceptions (waivers/exemptions from controls). This tool surfaces what exceptions are active, which controls have exceptions, and when exceptions are expiring.

**Parameters:**
- `controlPath` - Optional - Filter to exceptions for a specific control (e.g., "ci.dependabot.alerts")
- `status` - Optional - Filter by status: "active" (default), "inactive", or "all"
- `expiringSoon` - Optional - If true, only show exceptions expiring in the next 30 days

**Returns:**
- Summary (total exceptions, active count, expiring soon count, grouped by control)
- List of exceptions with details (name, control, justification, expiration)
- Insights and limitations

**Example questions:**
- *"What policy exceptions are active?"*
- *"Which controls have exceptions?"*
- *"What exceptions are expiring soon?"*
- *"Show me exceptions for dependabot alerts"*

**IMPORTANT LIMITATIONS:**
- The API does **NOT** expose who requested or created exceptions
- Only the approver role (e.g., "internal:system:admin") is available, not individual user identity
- Business line / org unit filtering is not available
- For questions like "Who requested the most exceptions?", this data is not exposed in the API

#### `resolve_external_artifact`
Resolve an artifact URI from Artifactory or container registries to find the corresponding Fianu asset and dashboard URL. Bridges external tools with Fianu for quick compliance lookups.

**Parameters:**
- `artifactUri` - REQUIRED - The artifact URI to resolve

**Supported Formats:**
- Container digests: `sha256:abc123...`
- GHCR images: `ghcr.io/org/repo/image@sha256:abc123...`
- Docker Hub: `docker.io/org/image:tag`
- Artifactory: `artifactory.example.com/docker-local/image:tag`

**Returns:**
- Repository name/UUID
- Application info
- Commit SHA
- **Fianu dashboard URL** (direct link!)
- Current compliance status

**Example questions:**
- *"Find Fianu dashboard for sha256:fd47edeaf25b10731a7117201a6243c371b4db33f05710bc0dec2d85d24e8c54"*
- *"What's the compliance status of ghcr.io/myorg/myapp@sha256:abc123..."*
- *"Take me to Fianu for this container image"*

**Use Case:** Copy a resource URI from Artifactory and immediately see its compliance status in Fianu without manual navigation.

### Troubleshooting

**OAuth not triggering?**
- Remove and re-add the MCP server to trigger a fresh registration
- For Cursor: Completely quit the app (Cmd+Q) and restart

**Connection failed?**
- Verify the server is reachable: `curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/health`
- Check Worker logs: `npx wrangler tail --env staging`

**Authentication failed?**
- Ensure your Auth0 account has access to the Fianu tenant
- Check that callback URLs are configured in Auth0 dashboard

For more detailed troubleshooting, see [CURSOR_SETUP.md](./CURSOR_SETUP.md) or [CLAUDE_DESKTOP_SETUP.md](./CLAUDE_DESKTOP_SETUP.md).

---

## Development

### Run Locally

```bash
npm run dev
```

This starts the Worker on `http://localhost:8788`.

### Test Health Check

```bash
curl http://localhost:8788/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "Fianu Compliance Intelligence MCP",
  "version": "0.1.0",
  "environment": "development"
}
```

### Test Authentication

```bash
# Get a JWT token from Auth0 (use Fianu dev environment)
TOKEN="your-auth0-jwt-token"

# Test authentication
curl -X POST http://localhost:8788/auth \\
  -H "Content-Type: application/json" \\
  -d "{\"token\": \"$TOKEN\"}"
```

### Adding New Tools

When creating new MCP tools, follow these patterns:

#### ⚠️ IMPORTANT: Use Plain JSON Schema, NOT Zod

MCP tool schemas **must be plain JSON Schema objects**, not Zod schemas. Zod schemas will not serialize correctly and will cause tool registration to fail with errors like:

```
Error listing tools: Invalid literal value, expected "object"
```

**✅ CORRECT - Plain JSON Schema:**
```typescript
export const myToolSchema = {
  type: 'object',
  properties: {
    requiredParam: {
      type: 'string',
      description: 'Description of the parameter',
    },
    optionalParam: {
      type: 'string', 
      description: 'Optional parameter description',
    },
  },
  required: ['requiredParam'],
};
```

**❌ WRONG - Zod Schema (will break MCP):**
```typescript
// DO NOT USE ZOD FOR MCP SCHEMAS
import { z } from 'zod';
export const myToolSchema = z.object({
  requiredParam: z.string().describe('...'),
  optionalParam: z.string().optional().describe('...'),
});
```

#### Tool File Structure

Create tools in `src/tools/` following this pattern:

```typescript
// src/tools/my-new-tool.ts
import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

// Schema MUST be plain JSON Schema object
export const myNewToolSchema = {
  type: 'object',
  properties: {
    // ... properties
  },
  required: ['requiredParam'],
};

export const myNewToolHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<any> => {
  const client = new ConsultaClient(env, session);
  
  // Extract args (no Zod parsing)
  const requiredParam = args.requiredParam as string;
  const optionalParam = args.optionalParam as string | undefined;
  
  // ... tool logic ...
  
  // Return MCP content format
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(result, null, 2),
    }],
  };
};
```

#### Register in compliance-mcp.ts

Import and register in `src/compliance-mcp.ts`:

```typescript
import { myNewToolHandler, myNewToolSchema } from './tools/my-new-tool';

// In registerTools():
this.toolHandlers.set('my_new_tool', {
  name: 'my_new_tool',
  description: `Tool description for the LLM...`,
  inputSchema: myNewToolSchema,
  handler: async (params) => myNewToolHandler(params, this.env, this.state),
});
```

---

## Deployment

### Deploy to Production

```bash
npm run deploy
# or: npx wrangler deploy --env production
```

### Deploy to Staging

```bash
npm run deploy:staging
# or: npx wrangler deploy --env staging
```

---

## Authentication

The MCP server now exposes standard **OAuth 2.0 (client_credentials grant)** endpoints so tools like `mcp-remote` and Claude Desktop can obtain tokens automatically.

### OAuth Endpoints

| Endpoint | Description |
|----------|-------------|
| `/.well-known/oauth-authorization-server` | Discovery document |
| `/register` | Dynamic client registration (returns short-lived client credentials) |
| `/token` | Exchanges the ephemeral credentials for an Auth0 access token |
| `/sse` | MCP SSE endpoint (requires `Authorization: Bearer <token>`) |

All OAuth endpoints are fronted by the Worker. `/token` proxies the request to Auth0 using the first-party client configured via `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET`, so secrets are never exposed to users.

### Manual Testing with curl

```bash
# 1. Register a temporary client (valid for 24h)
REG=$(curl -s -X POST https://mcp-compliance-intelligence-staging.noah-684.workers.dev/register)
CLIENT_ID=$(echo "$REG" | jq -r .client_id)
CLIENT_SECRET=$(echo "$REG" | jq -r .client_secret)

# 2. Exchange for a token
TOKEN=$(curl -s -X POST https://mcp-compliance-intelligence-staging.noah-684.workers.dev/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" | jq -r .access_token)

# 3. Call the SSE endpoint
curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: text/event-stream"
```

### Testing with Claude Desktop / mcp-remote

Claude Desktop automatically:
1. Fetches the discovery document
2. Calls `/register` to get client credentials
3. Exchanges them via `/token`
4. Connects to `/sse` with the returned bearer token

No manual setup is required beyond adding the MCP server URL in Claude Desktop.

---

## Testing

### Run Unit Tests

```bash
npm test
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Coverage Report

```bash
npm run test:coverage
```

---

## Monitoring

### View Logs

```bash
npx wrangler tail
```

### Analytics Engine

All tool invocations and API calls are logged to Cloudflare Analytics Engine for usage analysis.

**Datasets:**
- `compliance_mcp_staging` - Staging environment
- `compliance_mcp` - Production environment

#### Column Reference

Analytics Engine uses fixed column names. Here's what each column contains:

| Column | Tool Invocations (`mcp_tool_invocation`) | API Calls (`consulta_api_call`) |
|--------|------------------------------------------|--------------------------------|
| `blob1` | Event type: `'mcp_tool_invocation'` | Event type: `'consulta_api_call'` |
| `blob2` | Tool name (e.g., `analyze_control_failure`) | API endpoint (e.g., `/console/controls`) |
| `blob3` | User ID | User ID |
| `blob4` | Tenant ID | Tenant ID |
| `blob5` | Request params JSON (truncated to 1KB) | Status (`success`/`failure`) |
| `blob6` | Response JSON (truncated to 1KB) | Timestamp (ISO 8601) |
| `blob7` | Status (`success`/`failure`) | - |
| `blob8` | Timestamp (ISO 8601) | - |
| `double1` | Duration (ms) | Duration (ms) |
| `double2` | Request size (bytes) | HTTP status code |
| `double3` | Response size (bytes) | Response size (bytes) |
| `index1` | Status (`success`/`failure`) | Status (`success`/`failure`) |

#### Example Queries

```sql
-- Recent tool invocations with full details
SELECT 
  blob8 as timestamp,
  blob2 as tool_name,
  blob3 as user_id,
  blob4 as tenant_id,
  blob5 as request_params,
  blob6 as response,
  blob7 as status,
  double1 as duration_ms,
  double3 as response_size_bytes
FROM compliance_mcp_staging
WHERE blob1 = 'mcp_tool_invocation'
ORDER BY blob8 DESC
LIMIT 100;

-- Tool usage summary by user
SELECT 
  blob3 as user_id,
  blob2 as tool_name,
  COUNT(*) as call_count,
  AVG(double1) as avg_duration_ms,
  SUM(double3) as total_response_bytes
FROM compliance_mcp_staging
WHERE blob1 = 'mcp_tool_invocation'
GROUP BY blob3, blob2
ORDER BY call_count DESC;

-- Most popular tools
SELECT 
  blob2 as tool_name,
  COUNT(*) as calls,
  AVG(double1) as avg_duration_ms
FROM compliance_mcp_staging
WHERE blob1 = 'mcp_tool_invocation'
GROUP BY blob2
ORDER BY calls DESC;

-- API latency by endpoint
SELECT 
  blob2 as endpoint,
  COUNT(*) as calls,
  AVG(double1) as avg_ms,
  MAX(double1) as max_ms,
  AVG(double3) as avg_response_bytes
FROM compliance_mcp_staging
WHERE blob1 = 'consulta_api_call'
GROUP BY blob2
ORDER BY calls DESC;

-- Failed requests
SELECT 
  blob8 as timestamp,
  blob2 as tool_name,
  blob3 as user_id,
  blob5 as request_params,
  blob6 as error_response
FROM compliance_mcp_staging
WHERE blob1 = 'mcp_tool_invocation'
  AND blob7 = 'failure'
ORDER BY blob8 DESC;
```

### Workers Logs

For real-time debugging and full request/response data (not truncated), use Workers Logs:

1. **Dashboard:** Workers & Pages → Your Worker → Logs tab (enable "Persist logs")
2. **CLI:** `npx wrangler tail --env staging`

Log entries are tagged for easy filtering:
- `[AUDIT]` - Tool request/response with full JSON
- `[API]` - Consulta API call summary
- `[SECURITY]` - Security-relevant events (403 errors, etc.)

---

## Project Structure

```
mcp-compliance-intelligence/
├── src/
│   ├── index.ts                  # OAuth provider entry point
│   ├── compliance-mcp.ts         # McpAgent (Durable Object) - registers all tools
│   ├── types.ts                  # TypeScript definitions
│   ├── api/
│   │   └── consulta-client.ts    # Consulta API client with caching
│   ├── auth/
│   │   └── auth0-handler.ts      # Auth0 JWT validation
│   └── tools/
│       ├── get-asset-compliance-status.ts  # Asset compliance with controls
│       ├── list-controls.ts                # Control discovery
│       ├── get-compliance-summary.ts       # Executive compliance overview
│       ├── get-attestation-details.ts      # Attestation details (org-wide & asset-specific)
│       ├── get-deployment-attestations.ts  # Deployment-specific attestations
│       ├── get-pipeline-vulnerabilities.ts # Security scan vulnerabilities
│       ├── get-evidence-chain.ts           # Evidence lineage tracing
│       ├── get-policy-violations.ts        # Policy violations (failing controls)
│       ├── get-compliance-trends.ts        # Compliance trends over time
│       ├── get-deployment-blockers.ts      # Deployment blocking issues
│       ├── get-policy-exceptions.ts        # Policy exceptions/waivers
│       └── resolve-external-artifact.ts    # External artifact deep linking
├── test/                         # Unit and integration tests
├── wrangler.toml                 # Cloudflare configuration
├── package.json
├── tsconfig.json
├── env.example                   # Environment variables template
└── README.md
```

---

## Environment Variables

| Variable | Description | Set Via |
|----------|-------------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Account ID | wrangler.toml |
| `CONSULTA_URL` | Fianu Consulta API URL | wrangler.toml |
| `AUTH0_DOMAIN` | Auth0 domain | wrangler.toml |
| `AUTH0_ISSUER` | Auth0 issuer URL | wrangler.toml |
| `AUTH0_CLIENT_ID` | OAuth client ID | wrangler secret |
| `AUTH0_CLIENT_SECRET` | OAuth client secret | wrangler secret |
| `AUTH0_AUDIENCE` | API audience (optional) | wrangler secret |

---

## Security & Compliance

### Tenant Isolation

Every API request includes:
- `Authorization: Bearer <jwt>` - Auth0 token
- `X-Tenant-ID: <tenant_id>` - Extracted from JWT

Consulta API enforces Row-Level Security (RLS) at the database level.

### Audit Trail

All events logged to Analytics Engine and Workers Logs. See [Analytics Engine](#analytics-engine) section for:
- Column reference and schema
- Example SQL queries
- Workers Logs filtering

### Data Retention

- **Session state**: Stored in Durable Objects, expires with session
- **Cache**: 5-15 minutes TTL in KV Namespace
- **Audit logs**: 6 months in Analytics Engine

---

## Troubleshooting

### "Token validation failed"

- Check that Auth0 credentials are set: `npx wrangler secret list`
- Verify AUTH0_DOMAIN and AUTH0_ISSUER in wrangler.toml
- Ensure token is from the correct Auth0 tenant

### "Consulta API error: 403"

- Verify user has access to the tenant
- Check that `X-Tenant-ID` header matches JWT's tenant claim
- Confirm user has `read:compliance` scope

### "Cache hit rate is low"

- Check KV namespace is properly bound
- Verify CACHE_KV binding in wrangler.toml
- Review cache TTL values in consulta-client.ts

### "Durable Object not found"

- Run migrations: `npx wrangler deploy`
- Check that ComplianceMCP is exported in src/index.ts
- Verify durable_objects bindings in wrangler.toml

---

## Completed Features

- [x] **12 MCP Tools** - Asset compliance, controls, summary, attestations, deployments, vulnerabilities, evidence chains, policy violations, compliance trends, deployment blockers, policy exceptions, external artifact resolution
- [x] **OAuth 2.0 Authentication** - Automatic token handling via mcp-remote
- [x] **Executive Compliance Summary** - Risk categorization (CRITICAL/HIGH/MEDIUM/LOW)
- [x] **Vulnerability Delta Analysis** - Compare current vs previous commit to find introduced issues
- [x] **Org-wide Control Status** - Query pass/fail rates across all assets for a control
- [x] **Policy Violations as First-Class Concept** - Surface failing controls with severity and asset context
- [x] **Compliance Trends Over Time** - Smart sampling for trend analysis without backend materialized views
- [x] **Deployment Blockers Analysis** - Check what's blocking an application from deploying to a gate
- [x] **Policy Exceptions** - List and analyze exceptions/waivers with clear limitations on requester identity
- [x] **External Artifact Deep Linking** - Resolve Artifactory/container URIs to Fianu dashboard URLs
- [x] **LLM-optimized Tool Descriptions** - Clear guidance for AI assistants

## Roadmap

- [ ] Framework-specific filtering for controls (SOC2, ISO, NIST)
- [ ] Evidence gaps tool (missing/stale evidence detection)
- [ ] Compliance heat map visualization
- [ ] Redis event invalidation for cache
- [ ] Rate limiting per user
- [ ] Expand unit test coverage to 80%+
- [ ] Grafana dashboards for monitoring
- [ ] PagerDuty alerting for errors

---

## Support

- **Documentation**: https://docs.fianu.io/mcp/compliance-intelligence
- **Implementation Plan**: `/eng-specs/compliance-intelligence-mcp/implementation-plan.md`
- **Issues**: Contact Pete Zimmerman or file in Fianu repo

---

## License

Proprietary - Fianu Labs © 2025

