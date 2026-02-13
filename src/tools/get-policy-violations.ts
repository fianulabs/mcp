import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * Policy Violation structure
 * Represents a failing control that impacts compliance posture
 */
interface PolicyViolation {
  /** Unique identifier for this violation (attestation UUID) */
  uuid: string;
  /** Control path (e.g., cycode.secret.detection) */
  controlPath: string;
  /** Human-readable control name */
  controlName: string;
  /** Asset where the violation occurred */
  asset: {
    uuid: string;
    name: string;
    type?: string;
  };
  /** Commit SHA where violation was detected */
  commit?: string;
  /** Branch name if available */
  branch?: string;
  /** When the violation was recorded */
  timestamp: string;
  /** Control severity */
  severity?: string;
  /** Failure reason/message */
  reason?: string;
  /** Whether this violation blocked a deployment */
  impactedDeployment?: boolean;
  /** Age of violation in days */
  ageDays?: number;
}

/**
 * Aggregated violation summary by control
 */
interface ViolationSummary {
  controlPath: string;
  controlName: string;
  severity?: string;
  totalViolations: number;
  uniqueAssets: number;
  assets: string[];
  oldestViolation?: string;
  newestViolation?: string;
}

/**
 * Response from get_policy_violations tool
 */
interface PolicyViolationsResponse {
  summary: {
    totalViolations: number;
    uniqueControls: number;
    uniqueAssets: number;
    riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  };
  byControl: ViolationSummary[];
  violations: PolicyViolation[];
  query: {
    assetIdentifier?: string;
    controlPath?: string;
    severity?: string;
    since?: string;
    limit: number;
  };
  insights: string[];
  recommendations: string[];
}

/**
 * Handler for the get_policy_violations tool
 * 
 * This tool provides a first-class view of policy violations across the organization,
 * answering questions like:
 * - "What are all the policy violations across my organization?"
 * - "Which assets have secret detection failures?"
 * - "Show me all critical control failures"
 */
export const getPolicyViolationsHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<PolicyViolationsResponse> => {
  const client = new ConsultaClient(env, session);
  
  const assetIdentifier = args.assetIdentifier as string | undefined;
  const controlPath = args.controlPath as string | undefined;
  const severity = args.severity as string | undefined;
  const since = args.since as string | undefined;
  const limit = Math.min(Number(args.limit) || 100, 500);
  
  console.log(`[get_policy_violations] Starting: asset=${assetIdentifier || 'all'}, control=${controlPath || 'all'}, severity=${severity || 'all'}`);
  
  // Fetch failing attestations
  const violations = await client.getFailingAttestations({
    assetIdentifier,
    controlPath,
    severity,
    since,
    limit,
  });
  
  console.log(`[get_policy_violations] Found ${violations.length} violations`);
  
  // Aggregate by control
  const byControlMap = new Map<string, ViolationSummary>();
  const uniqueAssets = new Set<string>();
  
  for (const v of violations) {
    const key = v.controlPath || 'unknown';
    uniqueAssets.add(v.asset.name);
    
    if (!byControlMap.has(key)) {
      byControlMap.set(key, {
        controlPath: v.controlPath,
        controlName: v.controlName,
        severity: v.severity,
        totalViolations: 0,
        uniqueAssets: 0,
        assets: [],
        oldestViolation: v.timestamp,
        newestViolation: v.timestamp,
      });
    }
    
    const summary = byControlMap.get(key)!;
    summary.totalViolations++;
    
    if (!summary.assets.includes(v.asset.name)) {
      summary.assets.push(v.asset.name);
      summary.uniqueAssets++;
    }
    
    // Track time range
    if (v.timestamp) {
      if (!summary.oldestViolation || v.timestamp < summary.oldestViolation) {
        summary.oldestViolation = v.timestamp;
      }
      if (!summary.newestViolation || v.timestamp > summary.newestViolation) {
        summary.newestViolation = v.timestamp;
      }
    }
  }
  
  // Convert to sorted array
  const byControl = Array.from(byControlMap.values())
    .sort((a, b) => b.totalViolations - a.totalViolations);
  
  // Determine risk level based on violations
  let riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  const hasCritical = violations.some(v => v.severity === 'critical');
  const hasHigh = violations.some(v => v.severity === 'high');
  
  if (hasCritical || violations.length > 50) {
    riskLevel = 'CRITICAL';
  } else if (hasHigh || violations.length > 20) {
    riskLevel = 'HIGH';
  } else if (violations.length > 5) {
    riskLevel = 'MEDIUM';
  }
  
  // Check if severity filter was skipped (controls don't have severity data)
  const severityFilterSkipped = violations.some(v => v._severityFilterSkipped);
  
  // Generate insights
  const insights: string[] = [];
  
  if (violations.length === 0) {
    if (severity && !severityFilterSkipped) {
      insights.push(`No ${severity.toUpperCase()} severity violations found`);
    } else {
      insights.push('No policy violations found matching the criteria');
    }
  } else {
    insights.push(`Found ${violations.length} policy violations across ${uniqueAssets.size} assets`);
    
    // Add warning if severity filter was requested but couldn't be applied
    if (severity && severityFilterSkipped) {
      insights.push(`NOTE: Severity filter (${severity}) was ignored - controls in this organization don't have severity levels configured`);
    }
    
    if (byControl.length > 0) {
      const topControl = byControl[0];
      insights.push(`Most frequent violation: ${topControl.controlName || topControl.controlPath} (${topControl.totalViolations} occurrences)`);
    }
    
    if (hasCritical) {
      const criticalCount = violations.filter(v => v.severity === 'critical').length;
      insights.push(`${criticalCount} CRITICAL severity violations require immediate attention`);
    }
    
    // Check for deployment-blocking violations
    const deploymentBlockers = violations.filter(v => v.impactedDeployment);
    if (deploymentBlockers.length > 0) {
      insights.push(`${deploymentBlockers.length} violations are blocking deployments`);
    }
  }
  
  // Generate recommendations
  const recommendations: string[] = [];
  
  if (violations.length > 0) {
    if (hasCritical) {
      recommendations.push('Prioritize remediation of CRITICAL severity violations');
    }
    
    if (byControl.length > 0) {
      const topControl = byControl[0];
      if (topControl.totalViolations > 5) {
        recommendations.push(`Address ${topControl.controlName || topControl.controlPath} failures - affecting ${topControl.uniqueAssets} assets`);
      }
    }
    
    // Suggest asset-specific remediation if violations are concentrated
    if (uniqueAssets.size <= 3 && violations.length > 10) {
      const assetList = Array.from(uniqueAssets).slice(0, 3).join(', ');
      recommendations.push(`Focus remediation on high-impact assets: ${assetList}`);
    }
    
    recommendations.push('Use get_evidence_chain to trace root causes for specific violations');
    recommendations.push('Use get_attestation_details to see threshold values and evaluation details');
  }
  
  // Clean up internal fields from violations before returning
  const cleanViolations = violations.slice(0, 50).map(v => {
    const { _severityFilterSkipped, ...clean } = v;
    return clean;
  });
  
  const response = {
    summary: {
      totalViolations: violations.length,
      uniqueControls: byControl.length,
      uniqueAssets: uniqueAssets.size,
      riskLevel,
    },
    byControl,
    violations: cleanViolations,
    query: {
      assetIdentifier,
      controlPath,
      severity,
      since,
      limit,
    },
    insights,
    recommendations,
  };
  
  // Log response summary
  console.log(`[get_policy_violations] Response: ${response.summary.totalViolations} violations, ${response.summary.uniqueControls} controls`);
  
  // Return in MCP content format
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(response, null, 2)
    }],
  };
};

