/**
 * Cloudflare Workers Environment Bindings
 */
export interface Env {
  // Durable Object binding
  COMPLIANCE_MCP: DurableObjectNamespace;
  
  // KV Namespace for caching
  CACHE_KV: KVNamespace;
  
  // Analytics Engine for audit logging
  ANALYTICS: AnalyticsEngineDataset;
  
  // Environment variables
  ENVIRONMENT: string;
  CONSULTA_URL: string;
  AUTH0_DOMAIN: string;
  AUTH0_ISSUER: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_ORGANIZATION?: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  DEFAULT_TENANT_ID?: string;
}

/**
 * MCP Session State (stored in Durable Object)
 */
export interface SessionState {
  userId: string;
  tenantId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry: number;
  userEmail?: string;
  userName?: string;
  sessionStarted: number;
}

/**
 * Auth0 JWT Claims
 */
export interface Auth0Claims {
  sub: string; // user_id
  'https://fianu.io/tenant_id': string;
  'https://fianu.io/email'?: string;
  'https://fianu.io/name'?: string;
  scope: string;
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
}

/**
 * Consulta API Response Types
 */
export interface ComplianceStatus {
  asset: {
    uuid: string;
    name: string;
    type: string;
    branch?: string;
  };
  score: number;
  passing: number;
  failing: number;
  total: number;
  lastUpdated: string;
  controls: ControlStatus[];
  /** Total number of controls required by policy */
  requiredControls?: number;
  /** Number of required controls that are passing */
  requiredPassing?: number;
  /** Number of required controls with no evidence (not_found) */
  requiredNotFound?: number;
}

export interface ControlStatus {
  uuid: string;
  name: string;
  description: string;
  status: 'passing' | 'failing' | 'not_found' | 'not_applicable' | 'pending';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  passingChecks: number;
  failingChecks: number;
  totalChecks: number;
  /** Whether this control is required by policy - if true and not_found, it's a compliance issue */
  required?: boolean;
  /** The policy that requires this control */
  policyName?: string;
  /** Control path for identification */
  controlPath?: string;
}

export interface Control {
  uuid: string;
  name: string;
  description: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  framework: string;
  requirements: string[];
}

export interface ComplianceSummary {
  tenant: {
    id: string;
    name: string;
  };
  overallScore: number;
  totalAssets: number;
  compliantAssets: number;
  nonCompliantAssets: number;
  criticalIssues: number;
  highIssues: number;
  frameworks: FrameworkSummary[];
  lastUpdated: string;
}

export interface FrameworkSummary {
  name: string;
  score: number;
  controlsPassing: number;
  controlsFailing: number;
  controlsTotal: number;
}

/**
 * Audit Log Event
 */
export interface AuditEvent {
  eventType: 'mcp_tool_invocation' | 'consulta_api_call';
  userId: string;
  tenantId: string;
  toolName?: string;
  endpoint?: string;
  statusCode?: number;
  durationMs: number;
  success: boolean;
  timestamp: string;
}

