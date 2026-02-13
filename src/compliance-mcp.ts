import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env, SessionState } from './types';
import { ConsultaClient } from './api/consulta-client';
import {
  getAssetComplianceStatus,
  GetAssetComplianceStatusSchema,
} from './tools/get-asset-compliance-status';
import {
  listControls,
  ListControlsSchema,
} from './tools/list-controls';
import {
  getComplianceSummary,
  GetComplianceSummarySchema,
} from './tools/get-compliance-summary';
import {
  getAttestationDetails,
  GetAttestationDetailsSchema,
} from './tools/get-attestation-details';
import {
  getDeploymentAttestations,
  GetDeploymentAttestationsSchema,
} from './tools/get-deployment-attestations';
import {
  getPipelineVulnerabilities,
  GetPipelineVulnerabilitiesSchema,
} from './tools/get-pipeline-vulnerabilities';
import {
  getEvidenceChain,
  GetEvidenceChainSchema,
} from './tools/get-evidence-chain';
import {
  getPolicyViolationsHandler,
} from './tools/get-policy-violations';
import {
  getComplianceTrendsHandler,
} from './tools/get-compliance-trends';
import {
  getDeploymentBlockersHandler,
} from './tools/get-deployment-blockers';
import {
  exploreExceptionsHandler,
} from './tools/explore-exceptions';
import {
  getPolicyExceptionsHandler,
  getPolicyExceptionsSchema,
} from './tools/get-policy-exceptions';
import {
  resolveExternalArtifactHandler,
  resolveExternalArtifactSchema,
} from './tools/resolve-external-artifact';
import {
  analyzeControlFailureHandler,
  analyzeControlFailureSchema,
} from './tools/analyze-control-failure';
import {
  listReleasesHandler,
  listReleasesSchema,
} from './tools/list-releases';
import {
  getCommitAuthorsHandler,
  getCommitAuthorsSchema,
} from './tools/get-commit-authors';
import {
  getCapabilitiesHandler,
  getCapabilitiesSchema,
} from './tools/get-capabilities';

/**
 * Tool definition for MCP
 */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  handler: (params: any) => Promise<any>;
}

/**
 * Fianu Compliance Intelligence MCP Server
 * Durable Object that maintains stateful MCP sessions
 * Implements DurableObject directly without McpAgent to avoid SQLite dependency
 */
export class ComplianceMCP implements DurableObject {
  private state: SessionState;
  private server: McpServer;
  private toolHandlers = new Map<string, ToolDefinition>();
  private consulta: ConsultaClient | null = null;
  private initialized = false;

  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {
    this.state = {
      userId: '',
      tenantId: '',
      accessToken: '',
      tokenExpiry: 0,
      sessionStarted: Date.now(),
    };

    this.server = new McpServer({
      name: 'Fianu Compliance Intelligence',
      version: '0.1.0',
    }, {
      capabilities: {
        tools: {},
      },
    });
  }

  /**
   * Initialize MCP server and register tools
   */
  async init() {
    if (this.initialized) {
      return;
    }

    console.log('Initializing ComplianceMCP...', {
      userId: this.state.userId,
      tenantId: this.state.tenantId,
    });

    // Create Consulta API client
    this.consulta = new ConsultaClient(this.env, this.state);

    // Register MCP tools
    this.registerTools(this.consulta);

    this.initialized = true;
    console.log('ComplianceMCP initialized successfully');
  }

  /**
   * Register all MCP tools
   * Note: inputSchema must be JSON Schema format, not Zod schema
   */
  private registerTools(consulta: ConsultaClient) {
    // Tool 1: Get Asset Compliance Status
    const getAssetComplianceHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_asset_compliance_status',
        params,
        () => getAssetComplianceStatus(consulta, params)
      );
    };
    this.toolHandlers.set('get_asset_compliance_status', {
      name: 'get_asset_compliance_status',
      description: 'Get compliance status for a specific asset. Answers: "What is the compliance status of [asset]? Which controls are failing and why?" Returns: compliance score, all controls (passing/failing/missing), and actionable recommendations. Supports branch and commit filtering.',
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'Asset UUID or name to look up',
          },
          assetType: {
            type: 'string',
            description: 'Type of asset (repository, module, application)',
            enum: ['repository', 'module', 'application'],
          },
          branch: {
            type: 'string',
            description: 'Branch name (defaults to default branch)',
          },
        },
        required: ['assetIdentifier'],
      },
      handler: getAssetComplianceHandler,
    });

    // Tool 2: List Controls
    const listControlsHandler = async (params: any) => {
      return await this.withAuditLog(
        'list_controls',
        params,
        () => listControls(consulta, params)
      );
    };
    this.toolHandlers.set('list_controls', {
      name: 'list_controls',
      description: 'List all compliance controls configured in the organization. Answers: "What controls do we have?" or "Show me all critical controls". Returns: control names, paths, severity, and framework mappings. Use this to discover available control paths for other tools.',
      inputSchema: {
        type: 'object',
        properties: {
          framework: {
            type: 'string',
            description: 'Filter by compliance framework (e.g., SLSA, SOC2, PCI-DSS)',
          },
          severity: {
            type: 'string',
            description: 'Filter by severity level',
            enum: ['critical', 'high', 'medium', 'low', 'info'],
          },
        },
      },
      handler: listControlsHandler,
    });

    // Tool 3: Get Compliance Summary
    const getComplianceSummaryHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_compliance_summary',
        params,
        () => getComplianceSummary(consulta, params)
      );
    };
    this.toolHandlers.set('get_compliance_summary', {
      name: 'get_compliance_summary',
      description: 'Get organization-wide compliance summary for CISO/executive overview. Answers: "How healthy is my compliance posture right now?" Returns: risk level (CRITICAL/HIGH/MEDIUM/LOW), asset breakdown by type (repos/apps/modules), top failing controls, riskiest assets, and actionable recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          includeAssets: {
            type: 'boolean',
            description: 'Include individual asset details in the summary',
          },
          frameworkFilter: {
            type: 'string',
            description: 'Filter summary to a specific framework',
          },
        },
      },
      handler: getComplianceSummaryHandler,
    });

    // Tool 4: Get Attestation Details
    const getAttestationDetailsHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_attestation_details',
        params,
        () => getAttestationDetails(consulta, params)
      );
    };
    this.toolHandlers.set('get_attestation_details', {
      name: 'get_attestation_details',
      description: 'Get attestation details with TWO MODES: (1) ORG-WIDE: provide ONLY controlPath to see pass/fail status across ALL assets (e.g., "cycode.secret.detection is 15% passing across 84 assets"), (2) ASSET-SPECIFIC: provide assetIdentifier with optional controlPath for detailed attestation info including thresholds and measured values.',
      inputSchema: {
        type: 'object',
        properties: {
          controlPath: {
            type: 'string',
            description: 'Control path (e.g., cycode.secret.detection, sonarqube.codescan.coverage). USE ALONE for org-wide pass/fail status, or WITH assetIdentifier for asset-specific details.',
          },
          assetIdentifier: {
            type: 'string',
            description: 'Asset name or UUID. OMIT this to get org-wide status for a controlPath. INCLUDE for asset-specific attestation details.',
          },
          attestationUuid: {
            type: 'string',
            description: 'UUID of a specific attestation to fetch directly (if known).',
          },
          branch: {
            type: 'string',
            description: 'Branch name (e.g., "main"). Only used with assetIdentifier.',
          },
          commit: {
            type: 'string',
            description: 'Specific commit SHA (e.g., "3e2ab4d"). Only used with assetIdentifier.',
          },
        },
      },
      handler: getAttestationDetailsHandler,
    });

    // Tool 5: Get Deployment Attestations
    const getDeploymentAttestationsHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_deployment_attestations',
        params,
        () => getDeploymentAttestations(consulta, params)
      );
    };
    this.toolHandlers.set('get_deployment_attestations', {
      name: 'get_deployment_attestations',
      description: 'Show all attestations for an asset from a specific deployment record (not policy compliance). Answers: "Show me all attestations for [asset] in the last deployment". For policy compliance status, use get_asset_compliance_status instead.',
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'Asset name or UUID',
          },
          environment: {
            type: 'string',
            description: 'Environment to check deployments for (e.g., "QA", "PROD", "staging"). If not provided, shows deployments to all environments.',
          },
          deploymentId: {
            type: 'string',
            description: 'Specific deployment UUID to get attestations for. If not provided, uses the latest deployment.',
          },
        },
        required: ['assetIdentifier'],
      },
      handler: getDeploymentAttestationsHandler,
    });

    // Tool 6: Get Pipeline Vulnerabilities
    const getPipelineVulnerabilitiesHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_pipeline_vulnerabilities',
        params,
        () => getPipelineVulnerabilities(consulta, params)
      );
    };
    this.toolHandlers.set('get_pipeline_vulnerabilities', {
      name: 'get_pipeline_vulnerabilities',
      description: 'Get all vulnerabilities from security scans (SAST, SCA, secrets, container) for a repository. Answers: "What security vulnerabilities were found in [repo]?" or "Show me all critical vulnerabilities introduced by the last pipeline run for [repo]". Returns: vulnerability counts by severity, scan results, and failing scans. Use showIntroduced=true ONLY when user asks about "new" or "introduced" vulnerabilities.',
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'Repository name or UUID',
          },
          commit: {
            type: 'string',
            description: 'Specific commit SHA to check. If not provided, uses the latest commit on the branch.',
          },
          branch: {
            type: 'string',
            description: 'Branch to check (defaults to default branch, e.g., "main")',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'all'],
            description: 'Filter by severity level. Defaults to "all".',
          },
          showIntroduced: {
            type: 'boolean',
            description: 'If true, compare with previous commit to show only NEW vulnerabilities. Defaults to false.',
          },
        },
        required: ['assetIdentifier'],
      },
      handler: getPipelineVulnerabilitiesHandler,
    });

    // Tool 7: Get Evidence Chain
    const getEvidenceChainHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_evidence_chain',
        params,
        () => getEvidenceChain(consulta, params)
      );
    };
    this.toolHandlers.set('get_evidence_chain', {
      name: 'get_evidence_chain',
      description: `Trace the evidence chain (lineage) for a note, attestation, or commit. Shows how evidence flows from origin (trigger) through occurrences (data collection) to attestations (control evaluations) and optionally to deployment decisions.

Answers: "Show me the evidence chain for this attestation" or "What led to this deployment decision?" or "Trace the lineage from commit to attestation".

Use direction="upstream" to see ancestors (default), "downstream" to see children, or "full" for both.

WHEN TO USE THIS TOOL:
- User asks "what led to this failure/attestation" → use upstream
- User asks "what was generated from this build/workflow" → use downstream  
- User asks "show me the full evidence chain" → use full
- User mentions a specific attestation UUID → pass it as noteUuid
- User mentions an asset and commit → pass assetIdentifier + commit

OUTPUT STRUCTURE:
- origin: The triggering event (e.g., GitHub workflow)
- occurrence: Data collection events (builds, scans, artifacts)
- attestation: Control evaluations with pass/fail results
- Insights include data sources and failing controls

EXAMPLE CHAINS:
- GitHub workflow → CI build occurrence → Build attestation (pass) → Cosign signing → Signature attestation
- GitHub workflow → Cycode scan occurrence → Secret detection attestation (fail)`,
      inputSchema: {
        type: 'object',
        properties: {
          noteUuid: {
            type: 'string',
            description: 'UUID of a specific note (attestation, occurrence, or transaction) to trace. Either this or assetIdentifier is required.',
          },
          assetIdentifier: {
            type: 'string',
            description: 'Asset name (e.g., "fianu-fullstack-demo") or UUID. Use WITH commit parameter to find notes for that commit. The tool will find the origin note and trace from there.',
          },
          commit: {
            type: 'string',
            description: 'Specific commit SHA (e.g., "3e2ab4d"). Only used with assetIdentifier.',
          },
          branch: {
            type: 'string',
            description: 'Branch name (e.g., "main"). Only used with assetIdentifier.',
          },
          controlPath: {
            type: 'string',
            description: 'Control path (e.g., cycode.secret.detection, sonarqube.codescan.coverage). USE ALONE for org-wide pass/fail status, or WITH assetIdentifier for asset-specific details.',
          },
          direction: {
            type: 'string',
            enum: ['upstream', 'downstream', 'full'],
            description: 'Direction to trace: "upstream" (default) traces back to the origin/trigger, "downstream" shows all children/derived evidence, "full" shows both. Use upstream to understand "what caused this", downstream to see "what came from this".',
          },
          maxDepth: {
            type: 'number',
            description: 'Maximum depth for downstream traversal (default: 10). Increase if you need to see deeper trees.',
          },
        },
      },
      handler: getEvidenceChainHandler,
    });

    // Tool 8: Get Policy Violations
    const getPolicyViolationsToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_policy_violations',
        params,
        () => getPolicyViolationsHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('get_policy_violations', {
      name: 'get_policy_violations',
      description: `Get policy violations (failing controls) across the organization or for a specific asset. This tool surfaces failing attestations as "policy violations" - a first-class concept for compliance monitoring.

Answers: "What are all the policy violations?" or "Which assets are failing secret detection?" or "Show me critical control failures"

Returns: violation count, risk level, violations grouped by control, and actionable recommendations.

WHEN TO USE THIS TOOL:
- User asks about "policy violations" or "compliance failures"
- User asks "what's failing" across the organization
- User asks about control failures for a specific asset or control type
- User wants to see all failing controls with severity context

PARAMETERS:
- assetIdentifier: Optional - filter to a specific asset (name or UUID)
- controlPath: Optional - filter to a specific control (e.g., "cycode.secret.detection")
- severity: Optional - filter by severity level (critical, high, medium, low)
- since: Optional - only show violations since this date (ISO 8601 format, e.g., "2024-01-01")
- limit: Optional - maximum violations to return (default 100, max 500)

DEFAULT BEHAVIOR (no parameters):
- Returns ALL failing attestations across the ENTIRE organization
- Up to 100 violations (use limit to increase, max 500)
- No time filter - includes all historical violations
- Sorted by most recent first

OUTPUT STRUCTURE:
- summary: Total violations, unique controls, unique assets, risk level (CRITICAL/HIGH/MEDIUM/LOW)
- byControl: Violations aggregated by control path with counts per asset
- violations: Individual violation records (limited to 50 in response)
- insights: Human-readable observations about the violations
- recommendations: Actionable next steps for remediation

EXAMPLE QUERIES:
- No params → "What are all policy violations in my organization?"
- assetIdentifier only → "What's failing for fianu-fullstack-demo?"
- controlPath only → "Which assets are failing secret detection?"
- severity only → "Show me all critical violations"
- since only → "What violations occurred this week?" (use ISO date like "2024-12-01")`,
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'Asset name or UUID to filter violations for a specific asset',
          },
          controlPath: {
            type: 'string',
            description: 'Control path to filter for a specific control type (e.g., "cycode.secret.detection")',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Filter by control severity level',
          },
          since: {
            type: 'string',
            description: 'Only show violations since this date (ISO 8601 format, e.g., "2024-01-01")',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of violations to return (default 100, max 500)',
          },
        },
      },
      handler: getPolicyViolationsToolHandler,
    });

    // Tool 9: Get Compliance Trends
    const getComplianceTrendsToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_compliance_trends',
        params,
        () => getComplianceTrendsHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('get_compliance_trends', {
      name: 'get_compliance_trends',
      description: `Analyze compliance trends over time using smart sampling. Shows how compliance has changed and which controls have improved or declined.

Answers: "How has compliance changed over the last 30 days?" or "Is my compliance improving or declining?" or "What controls have improved the most?"

WHEN TO USE THIS TOOL:
- User asks about compliance "trends", "changes over time", or "history"
- User asks if compliance is "improving" or "declining"
- User wants to see which controls have gotten better or worse
- User asks about compliance "trajectory" or "direction"

PARAMETERS:
- assetIdentifier: Optional - filter to a specific asset (name or UUID). If omitted, shows org-wide trends.
- period: Time period to analyze. Options: "7d" (7 days), "30d" (30 days, default), "90d" (90 days)

OUTPUT STRUCTURE:
- summary: Current score, period start score, trend direction (improving/stable/declining), change percent, confidence level
- highlights: Most improved controls (top 3), most declined controls (top 3)
- dataPoints: Sampled data points over time (max 30 points for performance)
- insights: Human-readable observations about the trends
- recommendations: Actionable next steps based on trend analysis

EXAMPLE QUERIES:
- "How has compliance changed over the last 30 days?" → period: "30d"
- "Is fianu-fullstack-demo improving?" → assetIdentifier: "fianu-fullstack-demo", period: "30d"
- "Show me compliance trends for the past week" → period: "7d"
- "What's the 90-day compliance trajectory?" → period: "90d"

NOTE: This tool uses smart sampling to ensure fast responses. For exact point-in-time data, use get_policy_violations with a specific date.`,
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'Asset name or UUID to filter trends for a specific asset. Omit for org-wide trends.',
          },
          period: {
            type: 'string',
            enum: ['7d', '30d', '90d'],
            description: 'Time period to analyze: "7d" (7 days), "30d" (30 days, default), "90d" (90 days)',
          },
        },
      },
      handler: getComplianceTrendsToolHandler,
    });

    // Tool 10: Get Deployment Blockers
    const getDeploymentBlockersToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_deployment_blockers',
        params,
        () => getDeploymentBlockersHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('get_deployment_blockers', {
      name: 'get_deployment_blockers',
      description: `Find what's blocking an application from deploying to a specific environment/gate. This tool checks all assets in an application against gate requirements and reports which controls are failing.

Answers: "What's blocking [app] from deploying to production?" or "Can we deploy DBX to staging?" or "Why can't we release the Digital Banking Experience?"

WHEN TO USE THIS TOOL:
- User asks what's "blocking" a deployment or release
- User asks if an application "can deploy" to an environment
- User mentions a specific application and wants to know deployment readiness
- User asks about "release blockers" or "deployment gates"

PARAMETERS:
- applicationName: REQUIRED - Application name or code (e.g., "DBX", "Digital Banking Experience", "my-app")
- targetEnvironment: Optional - Target gate/environment to check (default: "production"). Examples: "staging", "qa", "prod"

OUTPUT STRUCTURE:
- application: Resolved application info (name, code, uuid)
- targetGate: The gate being checked (name, entityKey)
- canDeploy: Boolean - true if all required controls pass
- summary: One-line summary of deployment status
- blockedAssets: Assets with failing controls, including failure reasons
- passingAssets: Assets that are compliant
- totalBlockers: Count of blocking controls
- insights: Analysis of blocking issues
- recommendations: Actionable steps to unblock deployment

EXAMPLE QUERIES:
- "What's blocking DBX from deploying to production?" → applicationName: "DBX", targetEnvironment: "production"
- "Can we deploy Digital Banking Experience to staging?" → applicationName: "Digital Banking Experience", targetEnvironment: "staging"
- "Why can't fianu-fullstack-demo release?" → applicationName: "fianu-fullstack-demo"

NOTE: This tool checks current compliance state. For historical deployment records, use get_deployment_attestations.`,
      inputSchema: {
        type: 'object',
        properties: {
          applicationName: {
            type: 'string',
            description: 'Application name or code to check (e.g., "DBX", "Digital Banking Experience")',
          },
          targetEnvironment: {
            type: 'string',
            description: 'Target gate/environment (default: "production"). Examples: "staging", "qa", "prod"',
          },
        },
        required: ['applicationName'],
      },
      handler: getDeploymentBlockersToolHandler,
    });

    // Tool 11: Explore Exceptions (temporary for API discovery)
    const exploreExceptionsToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'explore_exceptions',
        params,
        () => exploreExceptionsHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('explore_exceptions', {
      name: 'explore_exceptions',
      description: 'TEMPORARY: Explore policy exceptions API to discover available data structure',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: exploreExceptionsToolHandler,
    });

    // Tool 12: Get Policy Exceptions
    const getPolicyExceptionsToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_policy_exceptions',
        params,
        () => getPolicyExceptionsHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('get_policy_exceptions', {
      name: 'get_policy_exceptions',
      description: `List and analyze policy exceptions (waivers/exemptions from controls).

Answers: "What exceptions are active?" or "Which controls have the most exceptions?" or "What exceptions are expiring soon?"

IMPORTANT LIMITATIONS:
- The API does NOT expose who requested or created exceptions
- Only the approver role (e.g., "internal:system:admin") is available, not individual user identity
- Business line / org unit filtering is not available
- For questions like "Who requested the most exceptions?", this data is not exposed in the API

WHAT THIS TOOL CAN DO:
- List all active policy exceptions
- Filter by control path (e.g., "ci.dependabot.alerts")
- Filter by status (active/inactive/all)
- Show exceptions expiring soon (within 30 days)
- Group exceptions by control
- Show justification messages

PARAMETERS:
- controlPath: Optional - filter to a specific control
- status: Optional - "active" (default), "inactive", or "all"
- expiringSoon: Optional - if true, only show exceptions expiring in 30 days

EXAMPLE QUERIES:
- "What exceptions are active?" → get_policy_exceptions()
- "Show exceptions for dependabot alerts" → get_policy_exceptions(controlPath: "ci.dependabot.alerts")
- "What exceptions are expiring soon?" → get_policy_exceptions(expiringSoon: true)`,
      inputSchema: getPolicyExceptionsSchema,
      handler: getPolicyExceptionsToolHandler,
    });

    // Tool 13: Resolve External Artifact
    const resolveExternalArtifactToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'resolve_external_artifact',
        params,
        () => resolveExternalArtifactHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('resolve_external_artifact', {
      name: 'resolve_external_artifact',
      description: `Resolve an artifact URI from Artifactory or container registries to find the corresponding Fianu asset and dashboard URL.

Answers: "Take me to Fianu for this artifact" or "What's the compliance status of this container image?" or "Find the Fianu dashboard for this digest"

USE CASE: User copies a resource URI from Artifactory, container registry, or build system and wants to immediately see its compliance status in Fianu.

SUPPORTED FORMATS:
- Container digests: "sha256:abc123..."
- GHCR images: "ghcr.io/org/repo/image@sha256:abc123..."
- Docker Hub: "docker.io/org/image:tag"
- Artifactory: "artifactory.example.com/docker-local/image:tag"
- Generic artifact URIs with digests

WHAT IT RETURNS:
- Repository name and UUID
- Application/project info
- Commit SHA
- Fianu dashboard URL (direct link)
- Current compliance status

PARAMETERS:
- artifactUri: REQUIRED - The artifact URI to resolve

EXAMPLE QUERIES:
- "Find Fianu dashboard for sha256:fd47edeaf25b10731a7117201a6243c371b4db33f05710bc0dec2d85d24e8c54"
- "What's the compliance status of ghcr.io/fianulabs-demos/fianu-fullstack-demo/backend@sha256:fd47ed..."
- "Take me to the Fianu page for this container image: docker.io/myorg/myapp:v1.2.3"`,
      inputSchema: resolveExternalArtifactSchema,
      handler: resolveExternalArtifactToolHandler,
    });

    // Tool 14: Analyze Control Failure
    const analyzeControlFailureToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'analyze_control_failure',
        params,
        () => analyzeControlFailureHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('analyze_control_failure', {
      name: 'analyze_control_failure',
      description: `Analyze a control's OPA Rego policy to understand what it checks and why it's failing.

Answers: "Why is the secret detection control failing?" or "What does the coverage control actually check?" or "Show me the policy rules for cycode.secret.detection"

WHAT IT DOES:
1. Fetches the control definition including the OPA Rego policy code
2. Decodes and parses the Rego policy to show the actual rules
3. Shows policy thresholds (min coverage, max vulnerabilities, etc.)
4. Explains what conditions trigger pass/fail/notFound results
5. Optionally finds a failing attestation to show measured values

OUTPUT INCLUDES:
- Full decoded OPA Rego policy code
- Policy thresholds and data values (JSON)
- Individual rule clauses (pass, fail, notFound, notRequired)
- Human-readable explanation of what the control checks
- Possible failure reasons based on the policy logic
- Recommendations for remediation

PARAMETERS:
- controlPath: REQUIRED - Control path like "cycode.secret.detection" or "sonarqube.codescan.coverage"
- assetIdentifier: OPTIONAL - Asset name to find a specific failing attestation for context

EXAMPLE QUERIES:
- "Why is cycode.secret.detection failing? Analyze the control policy."
- "What does the sonarqube.codescan.coverage control actually check?"
- "Show me the OPA Rego for dependabot.alerts and explain the failure conditions"
- "Analyze ci.sbom.syft for fianu-fullstack-demo - why might it fail?"`,
      inputSchema: analyzeControlFailureSchema,
      handler: analyzeControlFailureToolHandler,
    });

    // Tool 15: List Releases
    const listReleasesToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'list_releases',
        params,
        () => listReleasesHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('list_releases', {
      name: 'list_releases',
      description: `List releases for an application - both upcoming (pending) and completed (released).

Answers: "What are the upcoming releases for DBX?" or "Show me the last 5 releases for Digital Banking Experience" or "What releases happened this week?"

WHEN TO USE THIS TOOL:
- User asks about "upcoming releases" or "pending releases"
- User asks about "recent releases" or "release history"
- User wants to see what releases are scheduled vs completed
- Before checking deployment blockers, to identify which release to check

IMPORTANT CONSTRAINTS:
- Releases are APPLICATION-level, not repository-level
- applicationName is REQUIRED - must specify which application
- Results capped at 50 releases maximum
- Time-based filtering limited to last 30 days
- API has server-side limit; application filtering is client-side

PARAMETERS:
- applicationName: REQUIRED - Application name or code (e.g., "DBX", "Digital Banking Experience")
- status: Optional - "pending" (upcoming), "released" (completed), or "all" (default: "all")
- limit: Optional - Max releases to return, 1-50 (default: 10)
- since: Optional - Filter by date. ISO format "2024-12-01" or relative "7d", "30d". Max 30 days back. Only applies to released status.

OUTPUT STRUCTURE:
- releases: Array of release info (uuid, name, status, targetEnvironment, dates)
- count: Number of releases returned
- totalMatched: Total matching releases (before limit truncation)
- truncated: Whether results were truncated
- insights: Observations about the releases
- limitations: API constraints to be aware of

EXAMPLE QUERIES:
- "What are the upcoming releases for DBX?" → applicationName: "DBX", status: "pending"
- "Show me the last 5 releases for Digital Banking Experience" → applicationName: "Digital Banking Experience", limit: 5
- "What releases happened in the last week for DBX?" → applicationName: "DBX", status: "released", since: "7d"
- "List all DBX releases" → applicationName: "DBX", status: "all"`,
      inputSchema: listReleasesSchema,
      handler: listReleasesToolHandler,
    });

    // get_commit_authors tool - simplified for fast point-in-time lookups
    const getCommitAuthorsToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_commit_authors',
        params,
        () => getCommitAuthorsHandler(params, this.env, this.state)
      );
    };
    this.toolHandlers.set('get_commit_authors', {
      name: 'get_commit_authors',
      description: `Get commit authors for a specific repository from the most recent commit history.

Answers: "Who are the recent commit authors for fianu-fullstack-demo?" or "Show me who committed to the main branch"

WHEN TO USE THIS TOOL:
- User asks about commit authors for a specific repository
- User wants to see who made recent commits
- User asks about who authored code changes

WHAT THIS TOOL RETURNS:
- List of unique authors from the most recent commit history attestation
- Author name, email, and optional GitHub login
- Commit SHA and message for each author's commit
- Branch and PR information if available

LIMITATIONS:
- Returns authors from the MOST RECENT commit history attestation only
- For historical aggregation over time, use the Fianu UI dashboard
- Requires the repository to have ci.commithistory.codereview attestations

PARAMETERS:
- assetIdentifier: REQUIRED - Repository name or UUID
- branch: Optional - Filter to specific branch
- commit: Optional - Filter to specific commit SHA

EXAMPLE QUERIES:
- "Who committed to fianu-fullstack-demo?" → assetIdentifier: "fianu-fullstack-demo"
- "Show commit authors for main branch" → assetIdentifier: "my-repo", branch: "main"`,
      inputSchema: {
        type: 'object',
        properties: {
          assetIdentifier: {
            type: 'string',
            description: 'REQUIRED: Repository name or UUID',
          },
          branch: {
            type: 'string',
            description: 'Optional: Branch name to filter',
          },
          commit: {
            type: 'string',
            description: 'Optional: Specific commit SHA',
          },
        },
        required: ['assetIdentifier'],
      },
      handler: getCommitAuthorsToolHandler,
    });

    // get_capabilities tool - lists all available tools
    const getCapabilitiesToolHandler = async (params: any) => {
      return await this.withAuditLog(
        'get_capabilities',
        params,
        () => Promise.resolve(getCapabilitiesHandler(params))
      );
    };
    this.toolHandlers.set('get_capabilities', {
      name: 'get_capabilities',
      description: `List all available Fianu Compliance Intelligence tools with descriptions, example queries, and limitations.

Answers: "What can you do?" or "What capabilities does this MCP provide?" or "How can I use Fianu?"

WHEN TO USE THIS TOOL:
- User asks what the MCP can do
- User asks for help or a list of capabilities
- User wants to understand available tools
- First-time users exploring the system

WHAT THIS TOOL RETURNS:
- List of all available tools with descriptions
- Example queries for each tool
- Known limitations
- Helpful tips for getting started

PARAMETERS:
- category: Optional - Filter by category: compliance, security, releases, analysis, or all (default)`,
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'compliance', 'security', 'releases', 'analysis'],
            description: 'Filter tools by category (default: all)',
          },
        },
      },
      handler: getCapabilitiesToolHandler,
    });
  }

  /**
   * Wrap tool invocations with audit logging (includes full request/response)
   */
  private async withAuditLog<T>(
    toolName: string,
    params: any,
    handler: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      // Full request logging to console (for wrangler tail)
      console.log(`[AUDIT] Tool Request: ${toolName}`, JSON.stringify({
        timestamp: new Date().toISOString(),
        userId: this.state.userId,
        tenantId: this.state.tenantId,
        tool: toolName,
        request: params,
      }));

      const result = await handler();
      
      const duration = Date.now() - startTime;
      
      // Full response logging to console (for wrangler tail)
      console.log(`[AUDIT] Tool Response: ${toolName}`, JSON.stringify({
        timestamp: new Date().toISOString(),
        userId: this.state.userId,
        tenantId: this.state.tenantId,
        tool: toolName,
        durationMs: duration,
        success: true,
        response: result,
      }));
      
      await this.logToolInvocation(toolName, params, result, duration, true);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Full error logging to console
      console.error(`[AUDIT] Tool Error: ${toolName}`, JSON.stringify({
        timestamp: new Date().toISOString(),
        userId: this.state.userId,
        tenantId: this.state.tenantId,
        tool: toolName,
        durationMs: duration,
        success: false,
        request: params,
        error: errorMessage,
      }));
      
      await this.logToolInvocation(toolName, params, { error: errorMessage }, duration, false);
      
      throw error;
    }
  }

  /**
   * Truncate string to fit Analytics Engine blob limit (1024 bytes)
   */
  private truncateForAnalytics(str: string, maxLength: number = 1000): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Log tool invocation to Analytics Engine for audit trail
   * Includes request params and response (truncated to fit blob limits)
   */
  private async logToolInvocation(
    toolName: string,
    params: any,
    result: any,
    durationMs: number,
    success: boolean
  ): Promise<void> {
    try {
      const paramsJson = JSON.stringify(params || {});
      const resultJson = JSON.stringify(result || {});
      
      await this.env.ANALYTICS.writeDataPoint({
        blobs: [
          'mcp_tool_invocation',                           // blob1: event type
          toolName,                                         // blob2: tool name
          this.state.userId || 'anonymous',                 // blob3: user ID
          this.state.tenantId || 'unknown',                 // blob4: tenant ID
          this.truncateForAnalytics(paramsJson),            // blob5: request params (truncated)
          this.truncateForAnalytics(resultJson),            // blob6: response (truncated)
          success ? 'success' : 'failure',                  // blob7: status
          new Date().toISOString(),                         // blob8: timestamp
        ],
        doubles: [
          durationMs,                                       // double1: duration
          paramsJson.length,                                // double2: request size
          resultJson.length,                                // double3: response size
        ],
        indexes: [success ? 'success' : 'failure'],
      });
    } catch (error) {
      console.error('Failed to log tool invocation:', error);
    }
  }

  /**
   * Set session state (called by OAuth handler after authentication)
   */
  async setSessionState(state: Partial<SessionState>) {
    this.state = {
      ...this.state,
      ...state,
    };
    
    // Reset initialization when state changes (new user/session)
    if (state.userId && state.userId !== this.state.userId) {
      this.initialized = false;
      this.consulta = null;
    }
    
    console.log('Session state set:', {
      userId: this.state.userId,
      tenantId: this.state.tenantId,
    });
  }

  /**
   * Override fetch to handle MCP requests directly
   * This bypasses the SQLite requirement from McpAgent base class
   */
  async fetch(request: Request): Promise<Response> {
    console.log('ComplianceMCP.fetch called', {
      url: request.url,
      method: request.method,
      pathname: new URL(request.url).pathname,
    });
    
    const url = new URL(request.url);
    
    // Handle internal session setup requests
    if (url.pathname === '/set-session' || url.hostname === 'internal') {
      try {
        const body = await request.json();
        await this.setSessionState(body);
        
        // Initialize MCP server if not already done
        await this.init();
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Failed to set session:', error);
        return new Response(JSON.stringify({ 
          error: 'Failed to set session',
          details: error instanceof Error ? error.message : String(error),
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Initialize MCP server if not already done
    await this.init();
    console.log('After init, toolHandlers size:', this.toolHandlers.size);
    
    // Handle MCP protocol requests (JSON-RPC over HTTP)
    // Parse JSON-RPC request and route to appropriate handler
    let requestId: any = null;
    try {
      // Handle GET requests (health check or SSE connection establishment)
      if (request.method === 'GET') {
        console.log('GET request to Durable Object - returning server info');
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'Fianu Compliance Intelligence', version: '0.1.0' },
          },
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = await request.json();
      
      // Validate body is not null/undefined
      if (!body || typeof body !== 'object') {
        console.error('Invalid request body:', body);
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
            data: 'Request body is null or not an object',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const { jsonrpc, id, method, params } = body;
      requestId = id; // Save for error handling
      
      if (jsonrpc !== '2.0') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32600,
            message: 'Invalid Request',
            data: 'jsonrpc must be "2.0"',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      // Route to appropriate handler
      let result;
      if (method === 'tools/list') {
        // Build tools list from registered tools
        console.log('tools/list called, toolHandlers size:', this.toolHandlers.size);
        const tools = Array.from(this.toolHandlers.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
        console.log('Returning tools:', tools.map(t => t.name));
        result = { tools };
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        // Call the tool handler directly from our map
        const toolDef = this.toolHandlers.get(name);
        if (!toolDef) {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: 'Tool not found',
              data: `Tool "${name}" is not registered`,
            },
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const toolResult = await toolDef.handler(args || {});
        // MCP protocol: tool results must have content array with type: text
        // Check if already wrapped (some handlers might return wrapped format)
        if (toolResult && toolResult.content && Array.isArray(toolResult.content)) {
          result = toolResult; // Already in correct format
        } else {
          result = {
            content: [{
              type: 'text',
              text: JSON.stringify(toolResult, null, 2),
            }],
          };
        }
      } else if (method === 'initialize') {
        // Return MCP protocol initialization response
        // capabilities must be an object, even if empty
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: 'Fianu Compliance Intelligence',
            version: '0.1.0',
          },
        };
        console.log('MCP initialize response:', JSON.stringify(result));
      } else if (method === 'notifications/initialized') {
        // Client notification that initialization is complete - no response needed
        result = {};
      } else {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found',
            data: `Unknown method: ${method}`,
          },
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('MCP request handling failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('Error stack:', errorStack);
      
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: requestId, // Use saved request ID instead of null
        error: {
          code: -32603,
          message: 'Internal error',
          data: errorMessage,
        },
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

