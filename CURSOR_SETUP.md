# Cursor IDE MCP Server Setup

Cursor can integrate with the same remote MCP server used by Claude Desktop, allowing you to build and test MCP tools directly in your IDE.

## Setup Instructions

### Option 1: Using mcp-remote (Recommended)

This is the same approach as Claude Desktop, ensuring consistency:

1. **Open Cursor Settings**:
   - Press `Cmd/Ctrl + ,` to open Settings
   - Navigate to `Features` > `MCP` (or search for "MCP" in settings)

2. **Add New MCP Server**:
   - Click `+ Add New MCP Server` or `Add Server` button

3. **Configure the Server**:
   - **Name**: `Fianu Compliance Intelligence`
   - **Type**: `stdio` (Standard Input/Output)
   - **Command**: `npx`
   - **Args**: 
     ```
     -y
     mcp-remote
     https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse
     ```
   - Or as a single command string: `npx -y mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

4. **OAuth Flow**:
   - When Cursor first connects, `mcp-remote` will automatically:
     - Open a browser window for Auth0 login
     - Complete the OAuth authorization flow
     - Cache the token for future sessions
   - You'll see a browser window open with Auth0 login - complete it and return to Cursor

5. **Save and Connect**:
   - Save the configuration
   - Cursor should show the MCP server as "Connected" in the MCP panel
   - Available tools will appear in the MCP tools list

### Option 2: Direct SSE Connection (if Cursor supports it)

Some versions of Cursor may support direct SSE connections:

1. **Open Cursor Settings**:
   - `Settings` > `Features` > `MCP`

2. **Add New MCP Server**:
   - Click `+ Add New MCP Server`

3. **Configure**:
   - **Name**: `Fianu Compliance Intelligence`
   - **Type**: `sse` (Server-Sent Events)
   - **URL**: `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

4. **OAuth**:
   - Cursor should handle OAuth automatically when first connecting
   - If prompted, complete the Auth0 login flow

## Testing in Cursor

Once configured, you can:

1. **Use in Composer**:
   - Open Cursor's Composer (Cmd/Ctrl + I)
   - Ask questions like:
     - "What's my organization's compliance summary?"
     - "List all controls for our tenant"
     - "Get compliance status for asset X"

2. **View Available Tools**:
   - Check Cursor's MCP panel to see all available tools:
     - `get_compliance_summary`
     - `get_asset_compliance_status`
     - `list_controls`

3. **Debug Tool Calls**:
   - Cursor will show tool execution in the MCP panel
   - Check Cloudflare Worker logs for server-side debugging:
     ```bash
     cd mcp-compliance-intelligence
     export CLOUDFLARE_API_TOKEN="your-token"
     npx wrangler tail --env staging
     ```

## Development Workflow

### 1. Build & Test in Cursor
- Make changes to MCP tools in Cursor
- Test immediately using Composer
- See real-time results from Consulta API

### 2. Verify in Claude Desktop
- After testing in Cursor, verify the same functionality in Claude Desktop
- Ensures consistency across AI clients

### 3. Deploy Updates
```bash
cd mcp-compliance-intelligence
npm run deploy:staging
```

## Troubleshooting

### OAuth Flow Not Triggering

**Symptom**: OAuth flow doesn't start, or you see authentication errors even though you've configured the MCP server.

**Solution 1: Force Fresh OAuth by Removing and Re-adding**
1. Open Cursor Settings (`Cmd/Ctrl + ,`)
2. Go to `Features` > `MCP`
3. **Remove** the `fianu-compliance` server completely
4. **Completely quit Cursor** (Cmd+Q, don't just close the window)
5. Run the cache clearing script:
   ```bash
   cd mcp-compliance-intelligence
   ./clear-mcp-cache.sh
   ```
6. **Restart Cursor**
7. **Re-add** the MCP server (same configuration as before)
8. The OAuth flow should trigger automatically

**Solution 2: Force Fresh Registration with URL Parameter**
If Solution 1 doesn't work, temporarily modify the URL to force a new registration:
1. In Cursor MCP settings, change the URL to:
   ```
   https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse?force_new_session=true
   ```
2. Save and let Cursor reconnect
3. After OAuth completes, change it back to the original URL

**Solution 3: Manual Token Test**
Test if `mcp-remote` can authenticate outside of Cursor:
```bash
cd mcp-compliance-intelligence
npx mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse
```
- If this works, the issue is with Cursor's MCP integration
- If this fails, check Worker logs for errors

### OAuth Issues
- If OAuth fails, check that `http://localhost:9935/oauth/callback` is in Auth0's allowed callback URLs
- Clear Cursor's cache if authentication gets stuck
- **Known Issue**: Cursor sometimes doesn't trigger OAuth on first connection - try removing and re-adding the server

### Connection Issues
- Verify the Worker is deployed: `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/health`
- Check Worker logs for errors:
  ```bash
  cd mcp-compliance-intelligence
  export CLOUDFLARE_API_TOKEN="your-token"
  npx wrangler tail --env staging
  ```
- Ensure your Auth0 token has the `org_id` claim (set via Post-Login Action)

### Tool Not Appearing
- Refresh the MCP server list in Cursor
- Check that the tool is registered in `src/compliance-mcp.ts`
- Verify the tool schema is valid JSON
- Ensure the MCP server shows as "Connected" in Cursor's MCP panel

## Benefits of Using Cursor

1. **Faster Iteration**: Test tools immediately without switching to Claude Desktop
2. **Better Debugging**: See tool calls and responses in real-time
3. **Code Context**: Cursor has full context of your codebase when making tool calls
4. **Dual Verification**: Test in Cursor, then verify in Claude Desktop for final validation
5. **Integrated Development**: Build MCP tools while using them in the same IDE

## Quick Reference

### Configuration Summary

**Server URL**: `https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

**Command**: `npx -y mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse`

**OAuth**: Automatic via `mcp-remote` - browser will open on first connection

### Available Tools

Once connected, these tools are available in Cursor:

- **`get_compliance_summary`**: Get organization-wide compliance overview
  - Returns: Overall score, asset counts, metrics, insights
  
- **`get_asset_compliance_status`**: Get compliance status for a specific asset
  - Parameters: `assetIdentifier` (required), `assetType` (optional), `branch` (optional)
  
- **`list_controls`**: List all controls for the tenant
  - Parameters: `framework` (optional), `severity` (optional)

## Next Steps

1. Add more MCP tools based on your needs
2. Enhance existing tools with better error handling
3. Add more Consulta API endpoints as needed
4. Build tool chains (tools that call other tools)

