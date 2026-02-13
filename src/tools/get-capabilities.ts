import { z } from 'zod';

export const getCapabilitiesSchema = z.object({
  category: z.enum(['all', 'compliance', 'security', 'releases', 'analysis']).optional().default('all').describe(
    'Optional: Filter tools by category. Default is "all".'
  ),
});

export type GetCapabilitiesInput = z.infer<typeof getCapabilitiesSchema>;

interface ToolInfo {
  name: string;
  description: string;
  category: 'compliance' | 'security' | 'releases' | 'analysis';
  exampleQueries: string[];
  limitations?: string[];
}

// Static tool definitions - update when adding new tools
const TOOLS: ToolInfo[] = [
  {
    name: 'get_compliance_summary',
    description: 'Organization-wide compliance health overview with risk level and recommendations',
    category: 'compliance',
    exampleQueries: ['How healthy is my compliance posture?', 'Give me an executive summary'],
  },
  {
    name: 'get_asset_compliance_status',
    description: 'Detailed compliance status for a specific asset with all controls',
    category: 'compliance',
    exampleQueries: ['What is the compliance status of fianu-fullstack-demo?', 'Which controls are failing?'],
  },
  {
    name: 'get_policy_violations',
    description: 'All policy violations (failing controls) across the organization',
    category: 'compliance',
    exampleQueries: ['What are all the policy violations?', 'Show me critical failures'],
  },
  {
    name: 'get_compliance_trends',
    description: 'Compliance trends over time (7d, 30d, 90d)',
    category: 'compliance',
    exampleQueries: ['How has compliance changed?', 'Is compliance improving?'],
    limitations: ['May be slow for large datasets'],
  },
  {
    name: 'list_controls',
    description: 'List all compliance controls configured in the organization',
    category: 'compliance',
    exampleQueries: ['What controls do we have?', 'Show me all critical controls'],
  },
  {
    name: 'get_policy_exceptions',
    description: 'List active policy exceptions (waivers)',
    category: 'compliance',
    exampleQueries: ['What exceptions are active?', 'What exceptions expire soon?'],
  },
  {
    name: 'get_pipeline_vulnerabilities',
    description: 'Security vulnerabilities from scans (SAST, SCA, secrets, container)',
    category: 'security',
    exampleQueries: ['What vulnerabilities were found?', 'Show me critical vulnerabilities'],
  },
  {
    name: 'get_deployment_blockers',
    description: 'Find what\'s blocking deployment to an environment',
    category: 'releases',
    exampleQueries: ['What\'s blocking DBX from production?', 'Can we deploy to staging?'],
  },
  {
    name: 'list_releases',
    description: 'List upcoming and completed releases for an application',
    category: 'releases',
    exampleQueries: ['What are the upcoming releases?', 'Show me recent releases'],
  },
  {
    name: 'get_deployment_attestations',
    description: 'Attestations from a specific deployment record',
    category: 'releases',
    exampleQueries: ['Show attestations from the last deployment'],
  },
  {
    name: 'get_evidence_chain',
    description: 'Trace evidence lineage for an attestation or commit',
    category: 'analysis',
    exampleQueries: ['Show me the evidence chain', 'What led to this decision?'],
  },
  {
    name: 'analyze_control_failure',
    description: 'Analyze why a control is failing (shows OPA policy)',
    category: 'analysis',
    exampleQueries: ['Why is secret detection failing?', 'What does this control check?'],
  },
  {
    name: 'get_attestation_details',
    description: 'Detailed attestation info for a control or asset',
    category: 'analysis',
    exampleQueries: ['Show org-wide status for secret detection', 'Get attestation details'],
  },
  {
    name: 'get_commit_authors',
    description: 'Get commit authors for a repository (most recent)',
    category: 'analysis',
    exampleQueries: ['Who committed to fianu-fullstack-demo?', 'Show commit authors'],
    limitations: ['Returns most recent attestation only'],
  },
  {
    name: 'resolve_external_artifact',
    description: 'Find Fianu dashboard for a container digest or artifact',
    category: 'analysis',
    exampleQueries: ['Find Fianu for this container image'],
  },
];

export interface CapabilitiesResponse {
  serverName: string;
  serverVersion: string;
  totalTools: number;
  categories: Record<string, number>;
  tools: ToolInfo[];
  tips: string[];
}

export function getCapabilitiesHandler(
  input: GetCapabilitiesInput
): CapabilitiesResponse {
  const category = input?.category || 'all';
  
  console.log('[get_capabilities] input:', JSON.stringify(input));
  console.log('[get_capabilities] category:', category);
  console.log('[get_capabilities] TOOLS count:', TOOLS.length);
  
  // Filter by category if specified
  const filteredTools = category === 'all' 
    ? TOOLS 
    : TOOLS.filter(t => t.category === category);
  
  console.log('[get_capabilities] filteredTools count:', filteredTools.length);

  // Count by category
  const categories: Record<string, number> = {};
  for (const t of TOOLS) {
    categories[t.category] = (categories[t.category] || 0) + 1;
  }

  return {
    serverName: 'Fianu Compliance Intelligence',
    serverVersion: '0.1.0',
    totalTools: TOOLS.length,
    categories,
    tools: filteredTools,
    tips: [
      '💡 Start with get_compliance_summary for an overview',
      '💡 Use get_policy_violations to find what needs fixing',
      '💡 Use get_deployment_blockers before releases',
      '💡 Most tools accept asset names, app codes, or UUIDs',
    ],
  };
}
