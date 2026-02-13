# Troubleshooting MCP Server Connection

## Issue: "Connection error: ZodError - issuer, authorization_endpoint undefined"

This error occurs when `mcp-remote` cannot fetch OAuth discovery metadata from the MCP server.

---

## ✅ **Quick Fix (Most Common)**

### 1. Completely Quit Claude Desktop

**On macOS:**
```bash
# Force quit Claude Desktop
pkill -9 "Claude"

# Or use Activity Monitor to force quit
```

**Important**: Don't just close the window - actually **Quit** the application (Cmd+Q).

### 2. Clear `mcp-remote` Cache

```bash
# Reinstall mcp-remote to clear any cached responses
npm uninstall -g mcp-remote
npm install -g mcp-remote
```

### 3. Verify the Endpoint is Working

```bash
curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse/.well-known/oauth-authorization-server
```

You should see:
```json
{
  "issuer": "https://dev-lztnxy5azm8j4zwx.us.auth0.com/",
  "authorization_endpoint": "https://dev-lztnxy5azm8j4zwx.us.auth0.com/authorize",
  ...
}
```

### 4. Restart Claude Desktop

```bash
open -a "Claude"
```

---

## 🔍 **Advanced Debugging**

### Check What `mcp-remote` is Trying to Fetch

Run `mcp-remote` directly to see what's happening:

```bash
npx mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse
```

This will show you:
- What URL it's trying to connect to
- Any errors it encounters
- OAuth flow details

### Enable Verbose Logging

Set environment variable before starting Claude:

```bash
export DEBUG=mcp-remote:*
open -a "Claude"
```

Then check Claude Desktop logs at:
```
~/Library/Logs/Claude/
```

### Test with curl Exactly as mcp-remote Would

```bash
# Test discovery endpoint
curl -v "https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse/.well-known/oauth-authorization-server"

# Should return HTTP 200 with JSON containing:
# - issuer
# - authorization_endpoint  
# - token_endpoint
# - response_types_supported
```

---

## 🐛 **Common Issues**

### Issue 1: Old Version Cached

**Symptom**: Endpoint works with curl but fails in Claude  
**Solution**: 
```bash
# Clear mcp-remote cache
rm -rf ~/.npm/_npx
npm uninstall -g mcp-remote
npm install -g mcp-remote

# Force quit Claude
pkill -9 "Claude"

# Restart
open -a "Claude"
```

### Issue 2: Network/Proxy Issues

**Symptom**: Curl works but mcp-remote fails  
**Solution**: Check if you're behind a proxy:
```bash
echo $HTTP_PROXY
echo $HTTPS_PROXY

# If set, temporarily unset:
unset HTTP_PROXY HTTPS_PROXY
```

### Issue 3: Claude Desktop Config Issue

**Symptom**: Error persists after all fixes  
**Solution**: Check your Claude config file:

```bash
cat ~/.config/Claude/claude_desktop_config.json
```

Should look like:
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

**Fix** if malformed:
```bash
# Backup
cp ~/.config/Claude/claude_desktop_config.json ~/.config/Claude/claude_desktop_config.json.backup

# Recreate
cat > ~/.config/Claude/claude_desktop_config.json <<EOF
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
EOF
```

---

## 🧪 **Verification Steps**

### Step 1: Test Server is Running
```bash
curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/health
# Expected: {"status":"healthy",...}
```

### Step 2: Test OAuth Discovery
```bash
curl https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse/.well-known/oauth-authorization-server | jq
# Expected: JSON with issuer, authorization_endpoint, etc.
```

### Step 3: Test mcp-remote Can Connect
```bash
# Run mcp-remote directly
npx mcp-remote https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse
# Should open browser for Auth0 login
```

### Step 4: Check Claude Logs
```bash
# View latest Claude logs
tail -f ~/Library/Logs/Claude/*.log
```

Look for:
- `Connection error` lines
- HTTP requests to the MCP server
- OAuth flow messages

---

## 🆘 **Still Not Working?**

### Option A: Use Local MCP Server (Debugging)

Instead of the remote server, run the MCP server locally:

```bash
cd /Users/petezimmerman/Documents/dev/mcp-compliance-intelligence
npm run dev
```

Then update Claude config to use localhost:
```json
{
  "mcpServers": {
    "fianu-compliance": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8788/sse"]
    }
  }
}
```

This lets you see all server logs in real-time.

### Option B: Try Without mcp-remote

Create a local MCP server that directly uses the ComplianceMCP class (no remote connection):

```bash
# TODO: Add local-only configuration
```

### Option C: Check Cloudflare Workers Status

```bash
# View worker logs
cd /Users/petezimmerman/Documents/dev/mcp-compliance-intelligence
npx wrangler tail --env staging
```

Then try connecting from Claude Desktop and watch for incoming requests.

---

## 📞 **Getting Help**

If none of these solutions work:

1. **Capture logs**:
   ```bash
   # Claude logs
   tail -100 ~/Library/Logs/Claude/*.log > ~/claude-debug.log
   
   # Worker logs
   cd /Users/petezimmerman/Documents/dev/mcp-compliance-intelligence
   npx wrangler tail --env staging > ~/worker-debug.log
   ```

2. **Test with verbose curl**:
   ```bash
   curl -v https://mcp-compliance-intelligence-staging.noah-684.workers.dev/sse/.well-known/oauth-authorization-server 2>&1 | tee ~/curl-debug.log
   ```

3. **Share**:
   - `~/claude-debug.log`
   - `~/worker-debug.log`  
   - `~/curl-debug.log`
   - Your `~/.config/Claude/claude_desktop_config.json`

---

## ✅ **Success Checklist**

When working correctly, you should see:
- ✅ Curl to `/sse/.well-known/oauth-authorization-server` returns JSON (not error)
- ✅ Running `npx mcp-remote <url>` opens Auth0 login page
- ✅ After logging in, Claude Desktop shows "fianu-compliance" server as connected
- ✅ In Claude chat, you can ask compliance questions and see tool invocations

---

## 🔐 **Expected Auth Flow**

1. Claude Desktop starts `mcp-remote`
2. `mcp-remote` fetches `/sse/.well-known/oauth-authorization-server`
3. Discovers Auth0 endpoints
4. Opens browser to `https://dev-lztnxy5azm8j4zwx.us.auth0.com/authorize`
5. User logs in
6. Auth0 redirects to `http://localhost:9935/callback` with code
7. `mcp-remote` exchanges code for token
8. Connects to `/sse` with Bearer token
9. MCP tools are now available in Claude





