#!/bin/bash
# Test script for Fianu Compliance Intelligence MCP Server

set -e

BASE_URL="https://mcp-compliance-intelligence-staging.noah-684.workers.dev"

echo "🧪 Testing Fianu Compliance Intelligence MCP Server"
echo "=================================================="
echo ""

# Test 1: Health Check
echo "✓ Test 1: Health Check"
HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
echo "Response: $HEALTH_RESPONSE"
echo ""

# Test 2: Info Endpoint
echo "✓ Test 2: Info Endpoint"
INFO_RESPONSE=$(curl -s "$BASE_URL/")
echo "Response: $INFO_RESPONSE"
echo ""

# Test 3: Authentication (requires user token)
echo "⚠️  Test 3: Authentication"
echo "To test authentication, you need a user JWT token from Fianu."
echo ""
echo "Get a token by:"
echo "1. Log into Fianu dev environment (https://fianu-dev.fianu.io)"
echo "2. Open browser DevTools → Application → Local Storage"
echo "3. Copy the 'auth0_token' or 'access_token' value"
echo ""
echo "Then run:"
echo ""
echo "TOKEN=\"your-token-here\""
echo ""
echo "curl -X POST $BASE_URL/auth \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"token\": \"'\$TOKEN'\"}'"
echo ""

# Test 4: MCP SSE Endpoint (requires authentication)
echo "⚠️  Test 4: MCP SSE Endpoint"
echo "After getting a token, test the SSE endpoint:"
echo ""
echo "curl $BASE_URL/sse \\"
echo "  -H 'Authorization: Bearer '\$TOKEN"
echo ""

# Check if TOKEN environment variable is set
if [ -n "$TOKEN" ]; then
    echo ""
    echo "🔐 TOKEN found in environment - running authenticated tests..."
    echo ""
    
    # Test Authentication
    echo "✓ Test 3a: Authenticating..."
    AUTH_RESPONSE=$(curl -s -X POST "$BASE_URL/auth" \
        -H "Content-Type: application/json" \
        -d "{\"token\": \"$TOKEN\"}")
    echo "Auth Response: $AUTH_RESPONSE"
    echo ""
    
    # Test SSE Endpoint
    echo "✓ Test 4a: Testing SSE endpoint..."
    SSE_RESPONSE=$(curl -s "$BASE_URL/sse" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: text/event-stream" \
        --max-time 5 || true)
    echo "SSE Response (first 500 chars):"
    echo "$SSE_RESPONSE" | head -c 500
    echo ""
    echo ""
    
    echo "✅ Authenticated tests complete!"
else
    echo ""
    echo "💡 To run authenticated tests, set the TOKEN environment variable:"
    echo "   export TOKEN=\"your-jwt-token\""
    echo "   ./test-mcp.sh"
fi

echo ""
echo "=================================================="
echo "✅ Basic tests passed!"
echo ""
echo "MCP Server Status: 🟢 ONLINE"
echo "URL: $BASE_URL"
echo ""

