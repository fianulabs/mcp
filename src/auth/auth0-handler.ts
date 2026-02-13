import type { Env, Auth0Claims } from '../types';

/**
 * Auth0 OAuth handler for MCP server authentication
 *
 * MULTI-ISSUER VALIDATION STRATEGY:
 * Supports both staging and production Auth0 environments with custom domains
 * - Staging: auth.fianu.io (custom) or dev-lztnxy5azm8j4zwx.us.auth0.com (tenant)
 * - Production: cloudauth.fianu.io (custom) or fianu.us.auth0.com (tenant)
 *
 * JWT VALIDATION FLOW:
 * 1. Decode header to extract key ID (kid)
 * 2. Fetch public key from JWKS endpoint (cached for 1 hour)
 * 3. Verify signature using Web Crypto API
 * 4. Validate claims: issuer, expiry, audience, tenant ID
 */
export class Auth0Handler {
  private env: Env;
  private jwksCache: Map<string, any> = new Map(); // In-memory cache for JWKS public keys

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Validate Auth0 JWT and extract claims
   *
   * VALIDATION STEPS:
   * 1. Extract kid (key ID) from JWT header
   * 2. Fetch corresponding public key from Auth0 JWKS endpoint
   * 3. Verify JWT signature using Web Crypto API
   * 4. Validate issuer (supports multiple issuers for staging/prod)
   * 5. Validate expiry with 5-minute negative leeway (fail fast)
   * 6. Validate audience matches configured API audience
   * 7. Ensure tenant ID claim is present
   *
   * @param token - JWT access token from Auth0
   * @returns Validated JWT claims including user ID and tenant ID
   * @throws Error if token is invalid, expired, or missing required claims
   */
  async validateToken(token: string): Promise<Auth0Claims> {
    try {
      // Step 1: Decode JWT header to get key ID (kid)
      // JWT format: header.payload.signature (all base64url encoded)
      const [headerB64] = token.split('.');
      const header = JSON.parse(atob(headerB64));
      const kid = header.kid;

      if (!kid) {
        throw new Error('JWT missing kid in header');
      }

      // Step 2: Get public key from JWKS endpoint (cached)
      const publicKey = await this.getPublicKey(kid);

      // Step 3: Verify JWT signature using Web Crypto API
      // This ensures the token hasn't been tampered with
      const verified = await this.verifyJWT(token, publicKey);
      if (!verified) {
        throw new Error('JWT signature verification failed');
      }

      // Step 4: Decode and validate claims
      const [, payloadB64] = token.split('.');
      const claims = JSON.parse(atob(payloadB64)) as Auth0Claims;

      // Step 5: Validate issuer - support multiple environments
      // We accept both custom domains and Auth0 tenant domains for flexibility
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

      // Step 6: Validate expiry with negative leeway (fail fast approach)
      // Negative leeway means we fail BEFORE the token actually expires
      // This gives users time to re-authenticate before their session breaks mid-operation
      const now = Math.floor(Date.now() / 1000);
      const leeway = -300; // Fail if token expires within next 5 minutes
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
   *
   * CACHING STRATEGY:
   * - Public keys are cached in memory for 1 hour
   * - This reduces latency and avoids rate limiting from Auth0
   * - Keys are rotated infrequently (Auth0 rotates keys periodically)
   * - Cache miss triggers a fetch from Auth0's JWKS endpoint
   *
   * JWKS (JSON Web Key Set) is the standard way to publish public keys for JWT verification
   *
   * @param kid - Key ID from JWT header
   * @returns CryptoKey for signature verification
   */
  private async getPublicKey(kid: string): Promise<CryptoKey> {
    // Check cache first to avoid unnecessary network requests
    if (this.jwksCache.has(kid)) {
      return this.jwksCache.get(kid);
    }

    // Fetch JWKS from Auth0's well-known endpoint
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

    // Import the JWK as a CryptoKey for Web Crypto API
    // RSASSA-PKCS1-v1_5 with SHA-256 is the standard signing algorithm for Auth0 JWTs
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify'] // Only allow verification operations
    );

    // Cache for 1 hour (Auth0 keys rarely rotate)
    this.jwksCache.set(kid, publicKey);
    setTimeout(() => this.jwksCache.delete(kid), 3600000); // 3600000ms = 1 hour

    return publicKey;
  }

  /**
   * Verify JWT signature using Web Crypto API
   *
   * JWT SIGNATURE VERIFICATION PROCESS:
   * 1. Split JWT into header, payload, and signature
   * 2. Concatenate header.payload as the signed data
   * 3. Decode signature from base64url to bytes
   * 4. Verify signature matches using RSA-SHA256 with public key
   *
   * This ensures the JWT was signed by Auth0 and hasn't been tampered with
   *
   * @param token - Complete JWT string
   * @param publicKey - Public key from JWKS
   * @returns true if signature is valid, false otherwise
   */
  private async verifyJWT(token: string, publicKey: CryptoKey): Promise<boolean> {
    try {
      const [headerB64, payloadB64, signatureB64] = token.split('.');

      // The signed data is "header.payload" (both base64url encoded)
      const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

      // Decode signature from base64url to bytes
      const signature = this.base64UrlDecode(signatureB64);

      // Verify signature using Web Crypto API
      // RSASSA-PKCS1-v1_5 is the RSA signature algorithm used by Auth0
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

