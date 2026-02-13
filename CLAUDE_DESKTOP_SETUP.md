# Claude Desktop Setup for Fianu Compliance Intelligence MCP

## Configuration

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

No manual token is needed anymore—the worker exposes standard OAuth discovery, registration, and token endpoints. Claude Desktop automatically:

1. Registers an ephemeral client via `/register`
2. Exchanges it for a token via `/token`
3. Connects to `/sse` with `Authorization: Bearer <token>`

## Testing

After configuring, restart Claude Desktop and try asking:
- "What compliance tools are available?"
- "Get compliance status for asset e9352fa1-df20-4247-bb72-28340c160c36"
- "List all controls"

## Troubleshooting

1. **OAuth error**: Remove and re-add the MCP server to trigger a fresh registration.
2. **Connection failed**: Check that the MCP server URL is correct and reachable.
3. **Authentication failed**: Tail the Worker logs (`npx wrangler tail --env staging`) for more detail.

