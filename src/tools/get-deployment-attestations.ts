import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_deployment_attestations tool
 * Answers: "Show me all attestations for [asset] in the last deployment and any gaps"
 */
export const GetDeploymentAttestationsSchema = z.object({
  assetIdentifier: z.string().describe('Asset name or UUID'),
  environment: z.string().optional().describe('Environment to check deployments for (e.g., "QA", "PROD", "staging"). If not provided, shows deployments to all environments.'),
  deploymentId: z.string().optional().describe('Specific deployment UUID to get attestations for. If not provided, uses the latest deployment.'),
});

export type GetDeploymentAttestationsParams = z.infer<typeof GetDeploymentAttestationsSchema>;

/**
 * Get all attestations for an asset's deployment and identify any gaps
 * 
 * This tool answers: "Show me all attestations for [asset] in the last deployment and any gaps"
 * 
 * Key concepts:
 * - "Last deployment" = most recent deployment record to an environment
 * - "All attestations" = evidence collected and associated with that deployment
 * - "Gaps" = controls with no attestation or failing attestations
 * 
 * Note: This is different from compliance status which checks against policy gates.
 * This tool shows what evidence was actually collected for a deployment that happened.
 */
export async function getDeploymentAttestations(
  consulta: ConsultaClient,
  params: GetDeploymentAttestationsParams
) {
  const { assetIdentifier, environment, deploymentId } = params;

  console.log(`getDeploymentAttestations: asset=${assetIdentifier}, environment=${environment || 'all'}, deploymentId=${deploymentId || 'latest'}`);

  // Step 1: Resolve asset context
  const context = await consulta.resolveAssetContext(assetIdentifier);

  if (!context.assetUuid) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Asset not found',
          message: `Could not resolve asset: ${assetIdentifier}`,
          suggestions: [
            'Check the asset name spelling',
            'Try using the full asset UUID',
            'Use get_compliance_summary to list available assets',
          ],
        }, null, 2)
      }],
    };
  }

  // Step 2: Get deployment history
  const deployments = await consulta.getAssetDeployments(context.assetUuid, environment);
  
  // Also try component releases as fallback
  let releases: any[] = [];
  if (deployments.length === 0) {
    releases = await consulta.getComponentReleases(context.assetUuid);
  }

  const allDeployments = [...deployments, ...releases];

  if (allDeployments.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'No deployments found',
          message: `No deployment records found for asset: ${context.assetName}`,
          asset: {
            name: context.assetName,
            uuid: context.assetUuid,
          },
          suggestions: [
            'This asset may not have any recorded deployments yet',
            'Check if deployments are being tracked for this asset',
            'Use get_asset_compliance_status to check compliance against policy gates instead',
            environment ? `Try without the environment filter to see all deployments` : undefined,
          ].filter(Boolean),
          hint: 'For compliance status without deployment history, use get_asset_compliance_status tool',
        }, null, 2)
      }],
    };
  }

  // Step 3: Find the target deployment
  let targetDeployment: any;
  
  if (deploymentId) {
    // Find specific deployment by ID
    targetDeployment = allDeployments.find(d => d.uuid === deploymentId);
    if (!targetDeployment) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Deployment not found',
            message: `Could not find deployment with ID: ${deploymentId}`,
            availableDeployments: allDeployments.slice(0, 5).map(d => ({
              uuid: d.uuid,
              environment: d.environmentName || d.environment,
              timestamp: d.timestamp,
              commit: d.commit?.substring(0, 7),
            })),
          }, null, 2)
        }],
      };
    }
  } else {
    // Use the most recent deployment
    targetDeployment = allDeployments[0];
  }

  // Step 4: Get attestations for this deployment
  let attestations: any[] = [];
  
  if (targetDeployment.uuid) {
    attestations = await consulta.getDeploymentAttestations(targetDeployment.uuid);
  }
  
  // If no attestations from deployment record, try to get attestations for the commit
  if (attestations.length === 0 && targetDeployment.commit) {
    console.log(`No attestations in deployment record, fetching for commit ${targetDeployment.commit}`);
    attestations = await consulta.getAssetAttestations(
      assetIdentifier,
      undefined,
      targetDeployment.commit
    );
  }

  // Step 5: Categorize attestations
  const passing: any[] = [];
  const failing: any[] = [];
  
  for (const att of attestations) {
    const summary = {
      uuid: att.uuid,
      controlPath: att.control?.path || att.path || att.tag,
      controlName: att.control?.name || att.tag || 'Unknown',
      result: att.result,
      timestamp: att.timestamp,
      measuredValue: att.measuredValue,
      threshold: att.threshold,
      evaluationSummary: att.evaluationSummary,
    };
    
    if (att.result === 'pass') {
      passing.push(summary);
    } else {
      failing.push(summary);
    }
  }

  // Step 6: Build response
  const deploymentInfo = {
    uuid: targetDeployment.uuid,
    environment: targetDeployment.environmentName || targetDeployment.environment || 'Unknown',
    target: targetDeployment.targetName || targetDeployment.target,
    timestamp: targetDeployment.timestamp,
    commit: targetDeployment.commit,
    commitShort: targetDeployment.commit?.substring(0, 7),
    artifact: targetDeployment.artifact,
    tag: targetDeployment.tag,
    changeRecord: targetDeployment.changeRecord,
  };

  // List other available deployments for context
  const otherDeployments = allDeployments
    .filter(d => d.uuid !== targetDeployment.uuid)
    .slice(0, 5)
    .map(d => ({
      uuid: d.uuid,
      environment: d.environmentName || d.environment,
      timestamp: d.timestamp,
      commit: d.commit?.substring(0, 7),
    }));

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        summary: {
          asset: context.assetName,
          assetUuid: context.assetUuid,
          deployment: deploymentInfo,
          totalAttestations: attestations.length,
          passing: passing.length,
          failing: failing.length,
          status: failing.length === 0 
            ? '✅ All attestations passing' 
            : `⚠️ ${failing.length} attestation(s) failing`,
        },
        ...(failing.length > 0 && { 
          failingAttestations: failing.slice(0, 10),
          failingHint: failing.length > 10 
            ? `Showing 10 of ${failing.length} failing attestations`
            : undefined,
        }),
        ...(passing.length > 0 && passing.length <= 10 && { 
          passingAttestations: passing 
        }),
        ...(passing.length > 10 && {
          passingCount: passing.length,
          passingHint: `${passing.length} attestations passing - use get_attestation_details for specific controls`,
        }),
        ...(otherDeployments.length > 0 && {
          otherDeployments,
          otherDeploymentsHint: `${allDeployments.length - 1} other deployment(s) available`,
        }),
        insights: generateDeploymentInsights(deploymentInfo, passing.length, failing.length, attestations.length),
      }, null, 2)
    }],
  };
}

/**
 * Generate human-readable insights for the deployment
 */
function generateDeploymentInsights(
  deployment: any,
  passing: number,
  failing: number,
  total: number
): string[] {
  const insights: string[] = [];

  // Deployment info
  if (deployment.environment) {
    insights.push(`📦 Deployment to ${deployment.environment}${deployment.timestamp ? ` on ${new Date(deployment.timestamp).toLocaleDateString()}` : ''}`);
  }
  
  if (deployment.changeRecord) {
    insights.push(`📋 Change Record: ${deployment.changeRecord}`);
  }

  if (deployment.tag) {
    insights.push(`🏷️ Version: ${deployment.tag}`);
  }

  // Attestation summary
  if (total === 0) {
    insights.push('⚠️ No attestations found for this deployment');
    insights.push('   → Evidence may not have been collected or linked to this deployment');
  } else if (failing === 0) {
    insights.push(`✅ All ${total} attestation(s) passing`);
  } else {
    insights.push(`📊 ${passing}/${total} attestations passing (${Math.round((passing / total) * 100)}%)`);
    insights.push(`❌ ${failing} attestation(s) failing - review for potential issues`);
  }

  return insights;
}
