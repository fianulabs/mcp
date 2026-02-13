import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_compliance_summary tool
 * Answers: "How healthy is my compliance posture for [organization/tenant] right now?"
 */
export const GetComplianceSummarySchema = z.object({
  includeTopRisks: z.boolean().optional().describe('Include top failing controls/risks. Defaults to true for executive overview.'),
  includeAssetBreakdown: z.boolean().optional().describe('Include breakdown by asset type. Defaults to true.'),
});

export type GetComplianceSummaryParams = z.infer<typeof GetComplianceSummarySchema>;

/**
 * Get organization-wide compliance summary for executive/CISO overview
 * 
 * Answers: "How healthy is my compliance posture right now?"
 * 
 * Provides:
 * - Overall compliance score and risk level
 * - Asset compliance breakdown
 * - Top failing controls (biggest risks)
 * - Actionable recommendations
 */
export async function getComplianceSummary(
  consulta: ConsultaClient,
  params: GetComplianceSummaryParams
) {
  const includeTopRisks = params.includeTopRisks !== false; // Default true
  const includeAssetBreakdown = params.includeAssetBreakdown !== false; // Default true

  // Fetch base compliance summary
  const summary = await consulta.getComplianceSummary();

  // Fetch detailed compliance data for deeper analysis
  let topFailingControls: any[] = [];
  let assetTypeBreakdown: any = null;
  let topRiskyAssets: any[] = [];
  
  if (includeTopRisks || includeAssetBreakdown) {
    try {
      const complianceData = await consulta.getOrganizationCompliance();
      
      if (includeTopRisks) {
        // Aggregate failing controls across all assets
        const controlFailures = new Map<string, { name: string; path: string; failCount: number; assets: string[] }>();
        
        for (const app of complianceData) {
          if (!app) continue;
          for (const asset of app.assets || []) {
            if (!asset) continue;
            for (const attestation of asset.attestations || []) {
              if (!attestation) continue;
              if (attestation.result === 'fail' || attestation.status === 'fail') {
                // Extract control info - skip if we can't identify a real control path
                const controlPath = attestation.control?.path || 
                                   attestation.path || 
                                   attestation.tag;
                const controlName = attestation.control?.name || 
                                   attestation.control?.displayKey;
                
                // Skip if this looks like a result value, not a control path
                if (!controlPath || 
                    controlPath === 'fail' || 
                    controlPath === 'pass' || 
                    controlPath === 'error' || 
                    controlPath === 'none' ||
                    controlPath === 'unknown') {
                  continue;
                }
                
                const displayName = controlName || controlPath.split('.').pop() || controlPath;
                
                const existing = controlFailures.get(controlPath) || { 
                  name: displayName, 
                  path: controlPath, 
                  failCount: 0, 
                  assets: [] 
                };
                existing.failCount++;
                const assetName = asset.name || asset.repository || app.app_name;
                if (assetName && !existing.assets.includes(assetName)) {
                  existing.assets.push(assetName);
                }
                controlFailures.set(controlPath, existing);
              }
            }
          }
        }
        
        // Sort by failure count and take top 5
        topFailingControls = Array.from(controlFailures.values())
          .sort((a, b) => b.failCount - a.failCount)
          .slice(0, 5)
          .map(c => ({
            control: c.name,
            path: c.path,
            failingCount: c.failCount,
            affectedAssets: c.assets.length,
            sampleAssets: c.assets.slice(0, 3),
          }));
      }
      
      if (includeAssetBreakdown) {
        // Count by asset type
        const byType: Record<string, { total: number; compliant: number; failing: number }> = {
          repository: { total: 0, compliant: 0, failing: 0 },
          application: { total: 0, compliant: 0, failing: 0 },
          module: { total: 0, compliant: 0, failing: 0 },
          other: { total: 0, compliant: 0, failing: 0 },
        };
        
        for (const app of complianceData) {
          if (!app) continue;
          
          // Count application itself
          const appType = 'application';
          byType[appType].total++;
          
          const appAttestations = (app.attestations || []).filter((a: any) => a != null);
          const appFailing = appAttestations.some((a: any) => a.result === 'fail' || a.status === 'fail');
          if (appFailing) {
            byType[appType].failing++;
          } else if (appAttestations.length > 0) {
            byType[appType].compliant++;
          }
          
          // Count nested assets
          for (const asset of app.assets || []) {
            if (!asset) continue;
            
            const assetType = asset.type || (asset.repository ? 'repository' : 'other');
            const typeKey = byType[assetType] ? assetType : 'other';
            byType[typeKey].total++;
            
            const assetAttestations = (asset.attestations || []).filter((a: any) => a != null);
            const assetFailing = assetAttestations.some((a: any) => a.result === 'fail' || a.status === 'fail');
            if (assetFailing) {
              byType[typeKey].failing++;
              
              // Track risky assets
              if (topRiskyAssets.length < 5) {
                const failCount = assetAttestations.filter((a: any) => a.result === 'fail' || a.status === 'fail').length;
                topRiskyAssets.push({
                  name: asset.name || asset.repository || 'Unknown',
                  type: typeKey,
                  failingControls: failCount,
                  application: app.app_name,
                });
              }
            } else if (assetAttestations.length > 0) {
              byType[typeKey].compliant++;
            }
          }
        }
        
        assetTypeBreakdown = Object.entries(byType)
          .filter(([_, data]) => data.total > 0)
          .map(([type, data]) => ({
            type,
            total: data.total,
            compliant: data.compliant,
            failing: data.failing,
            complianceRate: data.total > 0 ? Math.round((data.compliant / data.total) * 100) : 0,
          }));
          
        // Sort risky assets by failure count
        topRiskyAssets.sort((a, b) => b.failingControls - a.failingControls);
      }
    } catch (e) {
      console.warn('Failed to fetch detailed compliance data:', e);
    }
  }

  // Generate insights and recommendations
  const insights = generateSummaryInsights(summary, topFailingControls);
  const recommendations = generateRecommendations(summary, topFailingControls, topRiskyAssets);

  // Determine risk level with clearer categories
  const riskLevel = getRiskLevel(summary.overallScore, summary.criticalIssues, summary.highIssues);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        executiveSummary: {
          headline: `Organization Compliance: ${(summary.overallScore * 100).toFixed(0)}%`,
          riskLevel: riskLevel.level,
          riskIcon: riskLevel.icon,
          status: riskLevel.status,
        },
        metrics: {
          overallScore: `${(summary.overallScore * 100).toFixed(1)}%`,
          totalAssets: summary.totalAssets,
          compliantAssets: summary.compliantAssets,
          nonCompliantAssets: summary.nonCompliantAssets,
          complianceRate: `${((summary.compliantAssets / summary.totalAssets) * 100).toFixed(0)}%`,
          criticalIssues: summary.criticalIssues,
          highIssues: summary.highIssues,
        },
        ...(assetTypeBreakdown && assetTypeBreakdown.length > 0 && { 
          assetBreakdown: assetTypeBreakdown 
        }),
        ...(topFailingControls.length > 0 && { 
          topRisks: topFailingControls,
          topRisksNote: 'Controls with most failures across assets',
        }),
        ...(topRiskyAssets.length > 0 && {
          riskiestAssets: topRiskyAssets.slice(0, 3),
        }),
        insights,
        recommendations,
        tenant: summary.tenant,
        lastUpdated: summary.lastUpdated,
      }, null, 2)
    }],
  };
}

/**
 * Determine risk level based on score and issues
 */
function getRiskLevel(score: number, criticalIssues: number, highIssues: number): { level: string; icon: string; status: string } {
  if (criticalIssues > 0) {
    return { level: 'CRITICAL', icon: '🔴', status: 'Immediate action required' };
  }
  if (score < 0.5 || highIssues > 50) {
    return { level: 'HIGH', icon: '🟠', status: 'Significant compliance gaps' };
  }
  if (score < 0.7 || highIssues > 20) {
    return { level: 'MEDIUM', icon: '🟡', status: 'Needs attention' };
  }
  if (score < 0.9) {
    return { level: 'LOW', icon: '🟢', status: 'Good standing with minor gaps' };
  }
  return { level: 'MINIMAL', icon: '✅', status: 'Excellent compliance posture' };
}

/**
 * Generate AI-friendly insights from compliance summary
 */
function generateSummaryInsights(summary: any, topFailingControls: any[]): string[] {
  const insights: string[] = [];

  // Overall status with context
  const scorePercent = (summary.overallScore * 100).toFixed(0);
  const compliantPercent = Math.round((summary.compliantAssets / summary.totalAssets) * 100);
  
  insights.push(`📊 ${compliantPercent}% of assets (${summary.compliantAssets}/${summary.totalAssets}) are fully compliant`);

  // Issue counts
  if (summary.criticalIssues > 0) {
    insights.push(`🚨 ${summary.criticalIssues} CRITICAL issues require immediate action`);
  }

  if (summary.highIssues > 0) {
    insights.push(`⚠️ ${summary.highIssues} high-severity control failures detected`);
  }

  // Top risks insight
  if (topFailingControls.length > 0) {
    const topRisk = topFailingControls[0];
    insights.push(`🎯 Biggest gap: "${topRisk.control}" failing in ${topRisk.affectedAssets} asset(s)`);
  }

  // Perfect compliance
  if (summary.overallScore === 1.0) {
    insights.push(`🎉 Perfect compliance! All assets passing all controls`);
  }

  return insights;
}

/**
 * Generate actionable recommendations based on compliance data
 */
function generateRecommendations(summary: any, topFailingControls: any[], topRiskyAssets: any[]): string[] {
  const recommendations: string[] = [];

  // Priority 1: Critical issues
  if (summary.criticalIssues > 0) {
    recommendations.push(`🔴 URGENT: Address ${summary.criticalIssues} critical issue(s) immediately`);
  }

  // Priority 2: Top failing controls
  if (topFailingControls.length > 0) {
    const top3Controls = topFailingControls.slice(0, 3);
    for (const control of top3Controls) {
      recommendations.push(`📋 Fix "${control.control}" - failing in ${control.affectedAssets} asset(s)`);
    }
  }

  // Priority 3: Risky assets
  if (topRiskyAssets.length > 0 && recommendations.length < 5) {
    const riskiestAsset = topRiskyAssets[0];
    recommendations.push(`🔧 Review "${riskiestAsset.name}" - ${riskiestAsset.failingControls} failing control(s)`);
  }

  // General recommendations based on score
  if (summary.overallScore < 0.5 && recommendations.length < 5) {
    recommendations.push(`📈 Consider a compliance remediation sprint to address widespread gaps`);
  }

  if (recommendations.length === 0) {
    recommendations.push(`✅ Maintain current practices and monitor for new issues`);
  }

  return recommendations;
}

