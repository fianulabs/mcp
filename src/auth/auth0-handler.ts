import type { Env, Auth0Claims } from '../types';

/**
 * Auth0 OAuth handler for MCP server authentication
 * Handles JWT validation and tenant extraction
 */
export class Auth0Handler {
  private env: Env;
  private jwksCache: Map<string, any> = new Map();

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Validate Auth0 JWT and extract claims
   */
  async validateToken(token: string): Promise<Auth0Claims> {
    try {
      // Decode JWT header to get key ID
      const [headerB64] = token.split('.');
      const header = JSON.parse(atob(headerB64));
      const kid = header.kid;

      if (!kid) {
        throw new Error('JWT missing kid in header');
      }

      // Get public key from JWKS endpoint
      const publicKey = await this.getPublicKey(kid);

      // Verify JWT signature using Web Crypto API
      const verified = await this.verifyJWT(token, publicKey);
      if (!verified) {
        throw new Error('JWT signature verification failed');
      }

      // Decode and validate claims
      const [, payloadB64] = token.split('.');
      const claims = JSON.parse(atob(payloadB64)) as Auth0Claims;

      // Validate issuer - accept both custom domain and tenant domain
      // Production: cloudauth.fianu.io / fianu.us.auth0.com
      // Staging: auth.fianu.io / dev-lztnxy5azm8j4zwx.us.auth0.com
      const validIssuers = [
        this.env.AUTH0_ISSUER, // From env: tenant domain
        `https://${this.env.AUTH0_DOMAIN}/`, // From env: custom domain
        // Staging issuers
        'https://auth.fianu.io/',
        'https://dev-lztnxy5azm8j4zwx.us.auth0.com/',
        // Production issuers
        'https://cloudauth.fianu.io/',
        'https://fianu.us.auth0.com/',
      ];
      
      if (!validIssuers.includes(claims.iss)) {
        throw new Error(`Invalid issuer: ${claims.iss}. Expected one of: ${validIssuers.join(', ')}`);
      }

      // Validate expiry - check expiration FIRST before any other validation
      // Use negative leeway to fail faster (fail if token expires within next 5 minutes)
      const now = Math.floor(Date.now() / 1000);
      const leeway = -300; // Fail if token expires within next 5 minutes (negative = fail faster)
      if (claims.exp <= (now - leeway)) {
        const expiryDate = new Date(claims.exp * 1000).toISOString();
        const nowDate = new Date(now * 1000).toISOString();
        throw new Error(`Token expired or expiring soon. Expiry: ${expiryDate}, Now: ${nowDate}. Please re-authenticate immediately.`);
      }
      
      // Also check if token is close to expiring (within 1 minute) - force refresh
      if (claims.exp <= (now + 60)) {
        console.warn('Token expiring soon, should refresh:', {
          expiresIn: claims.exp - now,
          expiryDate: new Date(claims.exp * 1000).toISOString(),
        });
      }

      // Validate audience (if configured)
      if (this.env.AUTH0_AUDIENCE) {
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!audiences.includes(this.env.AUTH0_AUDIENCE)) {
          throw new Error('Invalid audience');
        }
      }

      // Ensure tenant ID is present (check both custom claim and org_id)
      // Staging uses: https://fianu.io/tenant_id
      // Production uses: org_id
      const tenantId = claims['https://fianu.io/tenant_id'] || claims.org_id;
      if (!tenantId) {
        throw new Error('Token missing tenant_id claim (checked https://fianu.io/tenant_id and org_id)');
      }

      return claims;
    } catch (error) {
      console.error('Token validation failed:', error);
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get public key from Auth0 JWKS endpoint
   */
  private async getPublicKey(kid: string): Promise<CryptoKey> {
    // Check cache first
    if (this.jwksCache.has(kid)) {
      return this.jwksCache.get(kid);
    }

    // Fetch JWKS from Auth0
    const jwksUrl = `https://${this.env.AUTH0_DOMAIN}/.well-known/jwks.json`;
    const response = await fetch(jwksUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.statusText}`);
    }

    const jwks = await response.json();
    const key = jwks.keys.find((k: any) => k.kid === kid);

    if (!key) {
      throw new Error(`Key ${kid} not found in JWKS`);
    }

    // Import public key
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );

    // Cache for 1 hour
    this.jwksCache.set(kid, publicKey);
    setTimeout(() => this.jwksCache.delete(kid), 3600000);

    return publicKey;
  }

  /**
   * Verify JWT signature using Web Crypto API
   */
  private async verifyJWT(token: string, publicKey: CryptoKey): Promise<boolean> {
    try {
      const [headerB64, payloadB64, signatureB64] = token.split('.');
      const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
      
      // Decode base64url signature
      const signature = this.base64UrlDecode(signatureB64);

      // Verify signature
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        signature,
        data
      );

      return verified;
    } catch (error) {
      console.error('JWT verification error:', error);
      return false;
    }
  }

  /**
   * Decode base64url string to Uint8Array
   */
  private base64UrlDecode(base64url: string): Uint8Array {
    // Convert base64url to base64
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const base64Padded = base64 + padding;
    
    // Decode base64 to binary string
    const binaryString = atob(base64Padded);
    
    // Convert binary string to Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
  }

  /**
   * Extract tenant ID from JWT claims
   * Supports both staging (https://fianu.io/tenant_id) and production (org_id)
   */
  static extractTenantId(claims: Auth0Claims): string {
    return claims['https://fianu.io/tenant_id'] || claims.org_id || '';
  }

  /**
   * Extract user ID from JWT claims
   */
  static extractUserId(claims: Auth0Claims): string {
    return claims.sub;
  }

  /**
   * Extract user email from JWT claims (if available)
   */
  static extractUserEmail(claims: Auth0Claims): string | undefined {
    return claims['https://fianu.io/email'];
  }

  /**
   * Extract user name from JWT claims (if available)
   */
  static extractUserName(claims: Auth0Claims): string | undefined {
    return claims['https://fianu.io/name'];
  }
}

