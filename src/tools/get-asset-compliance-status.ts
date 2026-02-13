import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_asset_compliance_status tool
 */
export const GetAssetComplianceStatusSchema = z.object({
  assetIdentifier: z.string().describe('Asset UUID, key, or name'),
  assetType: z.enum(['repository', 'module', 'application']).optional().describe('Type of asset'),
  branch: z.string().optional().default('default').describe('Branch name to check (default: default)'),
  commit: z.string().optional().describe('Specific commit SHA to check compliance for (e.g., "3e2ab4d"). If not provided, uses latest.'),
});

export type GetAssetComplianceStatusParams = z.infer<typeof GetAssetComplianceStatusSchema>;

/**
 * Get current compliance status for a specific asset
 */
export async function getAssetComplianceStatus(
  consulta: ConsultaClient,
  params: GetAssetComplianceStatusParams
) {
  const data = await consulta.getAssetCompliance(
    params.assetIdentifier,
    params.assetType,
    params.branch,
    params.commit
  );

  // Categorize controls
  const categorizedControls = categorizeControls(data.controls || []);
  
  // Generate AI-friendly insights
  const insights = generateInsights(data, categorizedControls);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        summary: `${data.asset.name} (${data.asset.type}) has a compliance score of ${(data.score * 100).toFixed(1)}% on branch "${data.branch || 'default'}"`,
        status: getOverallStatus(data, categorizedControls),
        data: {
          ...data,
          // Add categorized view for easier consumption
          controlsByStatus: categorizedControls,
        },
        insights,
      }, null, 2)
    }],
  };
}

/**
 * Categorize controls by status and whether they're required
 */
function categorizeControls(controls: any[]): {
  requiredPassing: any[];
  requiredFailing: any[];
  requiredMissing: any[];  // Required but no evidence - compliance issue!
  optionalPassing: any[];
  optionalFailing: any[];
  optionalNoEvidence: any[];  // Not required, no evidence - informational only
} {
  return {
    requiredPassing: controls.filter(c => c.required && c.status === 'passing'),
    requiredFailing: controls.filter(c => c.required && c.status === 'failing'),
    requiredMissing: controls.filter(c => c.required && c.status === 'not_found'),
    optionalPassing: controls.filter(c => !c.required && c.status === 'passing'),
    optionalFailing: controls.filter(c => !c.required && c.status === 'failing'),
    optionalNoEvidence: controls.filter(c => !c.required && c.status === 'not_found'),
  };
}

/**
 * Get overall compliance status considering required controls
 */
function getOverallStatus(data: any, categorized: ReturnType<typeof categorizeControls>): string {
  const hasRequiredMissing = categorized.requiredMissing.length > 0;
  const hasRequiredFailing = categorized.requiredFailing.length > 0;
  
  if (hasRequiredFailing || hasRequiredMissing) {
    return '❌ Non-Compliant';
  }
  
  if (data.score >= 0.8) {
    return '✅ Compliant';
  } else if (data.score >= 0.5) {
    return '⚠️  Partially Compliant';
  }
  
  return '❌ Non-Compliant';
}

/**
 * Generate insights from compliance data for AI assistant
 */
function generateInsights(data: any, categorized: ReturnType<typeof categorizeControls>): string[] {
  const insights: string[] = [];
  
  const totalRequired = categorized.requiredPassing.length + 
                       categorized.requiredFailing.length + 
                       categorized.requiredMissing.length;

  // Required controls status (most important)
  if (totalRequired > 0) {
    const requiredPassRate = totalRequired > 0 
      ? (categorized.requiredPassing.length / totalRequired * 100).toFixed(0)
      : '0';
    
    insights.push(`📋 Required Controls: ${categorized.requiredPassing.length}/${totalRequired} passing (${requiredPassRate}%)`);
    
    // Required controls failing - this is a compliance issue
    if (categorized.requiredFailing.length > 0) {
      insights.push(`❌ ${categorized.requiredFailing.length} required control(s) FAILING - must be addressed for compliance`);
      // List the failing controls
      for (const control of categorized.requiredFailing.slice(0, 5)) {
        insights.push(`   • ${control.name}: FAILING`);
      }
    }
    
    // Required controls with no evidence - this is also a compliance issue
    if (categorized.requiredMissing.length > 0) {
      insights.push(`⚠️  ${categorized.requiredMissing.length} required control(s) have NO EVIDENCE - evidence must be provided`);
      // List the missing controls
      for (const control of categorized.requiredMissing.slice(0, 5)) {
        insights.push(`   • ${control.name}: No evidence found`);
      }
    }
    
    // All required passing
    if (categorized.requiredFailing.length === 0 && categorized.requiredMissing.length === 0) {
      insights.push(`✅ All ${totalRequired} required controls are passing!`);
    }
  } else {
    insights.push(`ℹ️  No required controls found from policy gates`);
  }

  // Optional/additional controls (informational)
  const totalOptional = categorized.optionalPassing.length + 
                       categorized.optionalFailing.length;
  
  if (totalOptional > 0) {
    insights.push(`📊 Additional Evidence: ${categorized.optionalPassing.length} passing, ${categorized.optionalFailing.length} failing`);
  }
  
  // Note about optional controls with no evidence (NOT a compliance issue)
  if (categorized.optionalNoEvidence.length > 0) {
    insights.push(`ℹ️  ${categorized.optionalNoEvidence.length} optional control(s) have no evidence (not required by policy)`);
  }

  // Critical failures across all controls
  const criticalFailures = (data.controls || []).filter((c: any) => 
    c.status === 'failing' && c.severity === 'critical'
  ).length;
  
  if (criticalFailures > 0) {
    insights.push(`🚨 ${criticalFailures} CRITICAL severity control(s) failing - immediate action required!`);
  }

  // Last updated
  if (data.lastUpdated) {
    insights.push(`📅 Last checked: ${new Date(data.lastUpdated).toLocaleString()}`);
  }

  return insights;
}

