import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_attestation_details tool
 * 
 * SUPPORTS TWO MODES:
 * 1. ORG-WIDE VIEW: Provide ONLY controlPath (no assetIdentifier) to see pass/fail status across ALL assets
 *    Example: { controlPath: "cycode.secret.detection" } → "15% passing across 84 assets"
 * 
 * 2. ASSET-SPECIFIC VIEW: Provide assetIdentifier (optionally with controlPath) for detailed attestation info
 *    Example: { assetIdentifier: "my-repo", controlPath: "coverage" } → detailed attestation with thresholds
 */
export const GetAttestationDetailsSchema = z.object({
  attestationUuid: z.string().optional().describe('UUID of a specific attestation/note to fetch (if known)'),
  assetIdentifier: z.string().optional().describe('Asset name or UUID. If omitted with controlPath, shows ORG-WIDE status for that control.'),
  controlPath: z.string().optional().describe('Control path (e.g., cycode.secret.detection, sonarqube.codescan.coverage). Use ALONE for org-wide view, or WITH assetIdentifier for asset-specific view.'),
  branch: z.string().optional().describe('Branch name (e.g., "main"). Only used with assetIdentifier.'),
  commit: z.string().optional().describe('Specific commit SHA (e.g., "3e2ab4d"). Only used with assetIdentifier.'),
});

export type GetAttestationDetailsParams = z.infer<typeof GetAttestationDetailsSchema>;

/**
 * Get detailed attestation/note information
 * This is a foundational tool that can be chained with other tools to answer complex queries
 * 
 * FLEXIBLE INPUT - supports multiple ways to identify attestations:
 * 1. Direct UUID: If user has the attestation UUID, use it directly
 * 2. Asset + Control: Specify asset name and control path, we'll find the attestation
 * 3. Asset only: Get all recent attestations for an asset
 * 
 * Use cases:
 * - Get threshold and actual values for a specific control check
 * - Understand why a control is failing (e.g., "why is coverage failing for xd-trading-app?")
 * - Get historical attestation data
 */
export async function getAttestationDetails(
  consulta: ConsultaClient,
  params: GetAttestationDetailsParams
) {
  const { attestationUuid, assetIdentifier, controlPath, branch, commit } = params;

  // Strategy 1: Direct UUID lookup (fastest if user has it)
  if (attestationUuid) {
    console.log(`Fetching attestation by UUID: ${attestationUuid}`);
    const details = await consulta.getAttestationDetails(attestationUuid);
    
    if (!details) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Attestation not found',
            message: `Could not find attestation with UUID: ${attestationUuid}`,
            suggestion: 'The UUID may be incorrect or the attestation may have been archived. Try searching by asset + control instead.',
          }, null, 2)
        }],
      };
    }

    // Return formatted details only (no raw data to save context space)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: `Attestation details for ${attestationUuid}`,
          attestation: formatAttestationDetails(details),
        }, null, 2)
      }],
    };
  }

  // Strategy 2: Control-only lookup (org-wide view for a specific control)
  // Answers: "Given this control ID/path, show me its latest evidence and pass/fail status"
  if (controlPath && !assetIdentifier) {
    console.log(`Finding org-wide attestations for control: ${controlPath}`);
    
    // Query attestations directly by control path using /notes endpoint
    const attestations = await consulta.getAttestationsByControlPath(controlPath);
    
    // Group by asset and result
    const controlResults: {
      passing: Array<{ asset: string; assetUuid?: string; timestamp?: string; uuid?: string }>;
      failing: Array<{ asset: string; assetUuid?: string; timestamp?: string; uuid?: string; reason?: string }>;
    } = { passing: [], failing: [] };
    
    // Track unique assets
    const seenAssets = new Set<string>();
    
    for (const att of attestations) {
      const assetName = att.asset?.name || att.asset?.repository || att.assetName || 'Unknown';
      const assetUuid = att.asset?.uuid || att.assetUuid;
      const assetKey = assetUuid || assetName;
      
      // Only count most recent attestation per asset
      if (seenAssets.has(assetKey)) continue;
      seenAssets.add(assetKey);
      
      if (att.result === 'pass') {
        controlResults.passing.push({
          asset: assetName,
          assetUuid,
          timestamp: att.timestamp,
          uuid: att.uuid,
        });
      } else {
        controlResults.failing.push({
          asset: assetName,
          assetUuid,
          timestamp: att.timestamp,
          uuid: att.uuid,
          reason: att.evaluationSummary || att.message || att.detail?.message,
        });
      }
    }
    
    const total = controlResults.passing.length + controlResults.failing.length;
    const passRate = total > 0 
      ? Math.round((controlResults.passing.length / total) * 100) 
      : 0;
    
    // Get control metadata if available
    let controlInfo: any = null;
    try {
      const controls = await consulta.listControls();
      const normalizedPath = controlPath.toLowerCase();
      controlInfo = controls.find((c: any) => 
        c.path?.toLowerCase() === normalizedPath ||
        c.path?.toLowerCase().includes(normalizedPath)
      );
    } catch (e) {
      // Control metadata not critical
    }
    
    if (total === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: `No attestations found for control "${controlPath}"`,
            control: {
              path: controlPath,
              name: controlInfo?.name || controlPath.split('.').pop(),
            },
            status: { passRate: 'N/A', passing: 0, failing: 0, total: 0 },
            suggestions: [
              'This control may not be configured for any assets',
              'Try a partial path match (e.g., "secret" instead of full path)',
              'Use list_controls to see available control paths',
            ],
          }, null, 2)
        }],
      };
    }
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: `Control "${controlPath}" status: ${passRate}% passing across ${total} asset(s)`,
          control: {
            path: controlPath,
            name: controlInfo?.name || controlPath.split('.').pop(),
            description: controlInfo?.description,
          },
          status: {
            passRate: `${passRate}%`,
            passing: controlResults.passing.length,
            failing: controlResults.failing.length,
            total,
          },
          ...(controlResults.failing.length > 0 && {
            failingAssets: controlResults.failing.slice(0, 10).map(f => ({
              asset: f.asset,
              reason: f.reason,
              attestationUuid: f.uuid,
            })),
            ...(controlResults.failing.length > 10 && {
              failingHint: `Showing 10 of ${controlResults.failing.length} failing assets`,
            }),
          }),
          ...(controlResults.passing.length > 0 && controlResults.passing.length <= 5 && {
            passingAssets: controlResults.passing.map(p => p.asset),
          }),
          ...(controlResults.passing.length > 5 && {
            passingAssetsCount: controlResults.passing.length,
            passingHint: 'Use get_asset_compliance_status for specific asset details',
          }),
          insights: generateControlInsights(controlPath, controlResults, passRate),
        }, null, 2)
      }],
    };
  }

  // Strategy 3: Asset + optional Control lookup (most common use case)
  if (assetIdentifier) {
    console.log(`Finding attestations for asset: ${assetIdentifier}, control: ${controlPath || 'all'}, branch: ${branch || 'default'}, commit: ${commit || 'latest'}`);
    
    // Get attestations - this will resolve asset name to UUID and fetch attestation data
    // Pass a debug object to capture intermediate state
    const debugInfo: any = {};
    const attestations = await consulta.getAssetAttestations(assetIdentifier, controlPath, commit, debugInfo, branch);
    
    if (!attestations || attestations.length === 0) {
      // Try to provide helpful suggestions
      const suggestions = [];
      if (controlPath) {
        suggestions.push(`Try without the controlPath filter to see all attestations for this asset`);
        suggestions.push(`Common control paths: sonarqube.codescan.coverage, ci.commit.codereview, cycode.sast.vulnerabilities`);
      }
      suggestions.push(`Verify the asset exists using get_asset_compliance_status`);
      
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'No attestations found',
            asset: assetIdentifier,
            controlFilter: controlPath || 'none',
            commitFilter: commit || 'none',
            suggestions,
            // Include debug info to understand what happened
            debug: debugInfo,
          }, null, 2)
        }],
      };
    }

    // Format the response based on number of results
    // IMPORTANT: Limit response size to avoid consuming too much conversation context
    const MAX_DETAILED_ATTESTATIONS = 3;
    const MAX_SUMMARY_ATTESTATIONS = 10;
    
    // If filtering by control and got exactly one, provide detailed view
    if (controlPath && attestations.length === 1) {
      const att = formatAttestationDetails(attestations[0]);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: `Attestation for ${controlPath} on ${assetIdentifier}`,
            result: att.result,
            control: att.control,
            threshold: att.threshold,
            measuredValue: att.measuredValue,
            evaluationSummary: att.evaluationSummary,
            // Concise details only - no raw data
            timestamp: att.timestamp,
            attestationUuid: att.uuid,
          }, null, 2)
        }],
      };
    }

    // For multiple attestations, provide a summary to avoid overwhelming the context
    if (attestations.length > MAX_DETAILED_ATTESTATIONS) {
      // Group by result (pass/fail) and provide counts
      const passing = attestations.filter(a => a.result === 'pass');
      const failing = attestations.filter(a => a.result === 'fail' || a.result === 'failure');
      const other = attestations.filter(a => a.result !== 'pass' && a.result !== 'fail' && a.result !== 'failure');
      
      // Format only the most recent failing ones (most relevant)
      const recentFailing = failing.slice(0, MAX_SUMMARY_ATTESTATIONS).map(a => {
        const formatted = formatAttestationDetails(a);
        
        // Extract vulnerability summary if present (for security scan attestations)
        let vulnSummary: any = undefined;
        if (a.detail?.vulnerabilities && Array.isArray(a.detail.vulnerabilities)) {
          vulnSummary = {
            count: a.detail.vulnerabilities.length,
            sample: a.detail.vulnerabilities.slice(0, 3).map((v: any) => ({
              severity: v.severity,
              type: v.detection_type || v.type,
              message: v.message?.substring(0, 100),
            })),
          };
        } else if (a.detail?.summary) {
          vulnSummary = a.detail.summary;
        }
        
        return {
          uuid: a.uuid || formatted?.uuid,
          result: formatted?.result || a.result,
          control: formatted?.control?.path || formatted?.control?.name || a.control?.path,
          measuredValue: formatted?.measuredValue,
          threshold: formatted?.threshold,
          evaluationSummary: formatted?.evaluationSummary,
          timestamp: formatted?.timestamp || a.timestamp,
          ...(vulnSummary ? { vulnerabilities: vulnSummary } : {}),
        };
      });
      
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary: `Found ${attestations.length} attestation(s) for ${assetIdentifier}${controlPath ? ` matching "${controlPath}"` : ''}`,
            breakdown: {
              passing: passing.length,
              failing: failing.length,
              other: other.length,
            },
            // Only show failing attestations (most relevant for debugging)
            failingAttestations: recentFailing,
            hint: failing.length > MAX_SUMMARY_ATTESTATIONS 
              ? `Showing ${MAX_SUMMARY_ATTESTATIONS} of ${failing.length} failing attestations. Use controlPath to narrow results.`
              : undefined,
          }, null, 2)
        }],
      };
    }

    // Small number of results - show all with concise formatting
    const formattedAttestations = attestations.slice(0, MAX_SUMMARY_ATTESTATIONS).map(a => {
      const formatted = formatAttestationDetails(a);
      return {
        uuid: formatted.uuid,
        result: formatted.result,
        control: formatted.control,
        measuredValue: formatted.measuredValue,
        threshold: formatted.threshold,
        evaluationSummary: formatted.evaluationSummary,
        timestamp: formatted.timestamp,
      };
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: `Found ${attestations.length} attestation(s) for ${assetIdentifier}${controlPath ? ` matching "${controlPath}"` : ''}`,
          attestations: formattedAttestations,
          hint: 'Use controlPath parameter to filter to a specific control for threshold details',
        }, null, 2)
      }],
    };
  }

  // No parameters provided - provide helpful usage info
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'Missing parameters',
        message: 'Please specify what attestation you want to look up',
        examples: [
          { description: 'Get coverage attestation for an asset', params: { assetIdentifier: 'xd-trading-app', controlPath: 'coverage' } },
          { description: 'Get all attestations for an asset', params: { assetIdentifier: 'xd-trading-app' } },
          { description: 'Look up by UUID', params: { attestationUuid: 'abc-123-...' } },
        ],
        commonControlPaths: [
          'sonarqube.codescan.coverage - Unit test coverage',
          'sonarqube.codescan.reliability - Code reliability',
          'cycode.sast.vulnerabilities - SAST scan',
          'ci.commit.codereview - Code review',
          'cosign.sign.artifact - Artifact signature',
        ],
      }, null, 2)
    }],
  };
}

/**
 * Format attestation details into a readable structure
 * Based on Fior spec v3.0.0/v4.0.0
 * 
 * Key data locations in Fior spec:
 * - detail.overall_coverage = actual measured value (e.g., 0.58 for 58%)
 * - policy.data.overall_coverage.minimum = threshold (e.g., 0.8 for 80%)
 * - policy.evaluation.logs = human-readable explanation
 * - producer.entity = control info (name, path, uuid)
 */
function formatAttestationDetails(attestation: any): any {
  if (!attestation) return null;

  // Extract key information from the note structure
  const formatted: any = {
    uuid: attestation.uuid,
    result: attestation.result || attestation.metadata?.result,
    status: attestation.status || attestation.metadata?.status,
    path: attestation.path,
  };

  // Extract control information from producer.entity (Fior v3+)
  if (attestation.producer?.entity) {
    formatted.control = {
      uuid: attestation.producer.entity.uuid,
      name: attestation.producer.entity.name,
      path: attestation.producer.entity.path,
      type: attestation.producer.entity.type,
      version: attestation.producer.entity.version?.semantic,
    };
  } else if (attestation.metadata?.entity || attestation.control) {
    // Fallback for older formats
    formatted.control = {
      name: attestation.metadata?.entity?.displayKey || attestation.control?.name,
      path: attestation.metadata?.path || attestation.control?.path,
      version: attestation.metadata?.entity?.version || attestation.control?.version,
    };
  }

  // Extract measured values from detail (Fior v4 structure)
  // detail contains the actual measured values
  if (attestation.detail) {
    formatted.measurements = {};
    
    // Direct coverage fields (Fior v4 format)
    if (attestation.detail.overall_coverage !== undefined) {
      const coverage = attestation.detail.overall_coverage;
      formatted.measurements.overall_coverage = typeof coverage === 'number' && coverage <= 1 
        ? `${(coverage * 100).toFixed(1)}%` 
        : `${coverage}%`;
      formatted.measuredValue = formatted.measurements.overall_coverage;
      formatted.measuredValueRaw = coverage;
    }
    if (attestation.detail.new_coverage !== undefined) {
      const coverage = attestation.detail.new_coverage;
      formatted.measurements.new_coverage = typeof coverage === 'number' && coverage <= 1 
        ? `${(coverage * 100).toFixed(1)}%` 
        : `${coverage}%`;
    }
    if (attestation.detail.total_lines_to_cover !== undefined) {
      formatted.measurements.total_lines_to_cover = attestation.detail.total_lines_to_cover;
    }
    
    // SonarQube qualityGate conditions (alternative structure)
    if (attestation.detail.qualityGate?.conditions) {
      formatted.qualityGateConditions = attestation.detail.qualityGate.conditions.map((c: any) => ({
        metric: c.metric,
        actual: c.actual,
        threshold: c.error || c.errorThreshold,
        operator: c.op,
        status: c.level,
      }));
      
      // Find coverage specifically
      const coverageCondition = attestation.detail.qualityGate.conditions.find(
        (c: any) => c.metric === 'coverage' || c.metric === 'new_coverage'
      );
      if (coverageCondition && !formatted.measuredValue) {
        formatted.measuredValue = `${coverageCondition.actual}%`;
        formatted.measuredValueRaw = parseFloat(coverageCondition.actual) / 100;
      }
    }
    
    // For other metric types, capture all detail fields
    const knownFields = ['overall_coverage', 'new_coverage', 'total_lines_to_cover', 'new_lines_to_cover', 'qualityGate', 'mediaType'];
    for (const [key, value] of Object.entries(attestation.detail)) {
      if (!knownFields.includes(key) && value !== null && value !== undefined) {
        formatted.measurements[key] = value;
      }
    }
  }

  // Extract threshold from policy.data (Fior spec location)
  if (attestation.policy?.data) {
    formatted.policyThresholds = {};
    
    // Extract all threshold configurations
    for (const [key, value] of Object.entries(attestation.policy.data)) {
      if (typeof value === 'object' && value !== null && 'minimum' in (value as any)) {
        const minVal = (value as any).minimum;
        formatted.policyThresholds[key] = {
          minimum: minVal,
          minimumFormatted: typeof minVal === 'number' && minVal <= 1 
            ? `${(minVal * 100).toFixed(0)}%` 
            : minVal,
        };
        
        // Set the primary threshold for coverage controls
        if (key === 'overall_coverage' || key === 'coverage') {
          formatted.threshold = formatted.policyThresholds[key].minimumFormatted;
          formatted.thresholdRaw = minVal;
        }
      } else if (key !== 'required') {
        // Non-threshold config values
        formatted.policyThresholds[key] = value;
      }
    }
    
    // Fallback threshold extraction for new_coverage if overall not set
    if (!formatted.threshold && formatted.policyThresholds.new_coverage?.minimumFormatted) {
      formatted.threshold = formatted.policyThresholds.new_coverage.minimumFormatted;
      formatted.thresholdRaw = formatted.policyThresholds.new_coverage.minimum;
    }
  }

  // Extract evaluation logs (human-readable explanation)
  if (attestation.policy?.evaluation?.logs) {
    formatted.evaluationLogs = attestation.policy.evaluation.logs;
    // Often contains summaries like "Failed with 58% coverage compared to policy minimum of 80%"
    // This is the most user-friendly summary
    if (formatted.evaluationLogs.length > 0) {
      formatted.evaluationSummary = formatted.evaluationLogs[0];
    }
  }

  // Extract policy inheritance (shows policy chain)
  if (attestation.policy?.inheritance) {
    formatted.policyInheritance = attestation.policy.inheritance.map((p: any) => ({
      name: p.name,
      path: p.path,
      asset: p.asset?.name,
    }));
  }

  // Asset information
  if (attestation.asset) {
    formatted.asset = {
      uuid: attestation.asset.uuid || attestation.asset,
      name: attestation.asset.name,
      key: attestation.asset.key,
      type: attestation.asset.type?.name,
      commit: attestation.asset.scm?.repository?.commit,
      tag: attestation.asset.scm?.repository?.tag,
      repository: attestation.asset.scm?.repository?.name,
    };
  }

  // Timestamp
  formatted.timestamp = attestation.timestamp;
  formatted.origination = attestation.origination;

  // Display information (often contains human-readable summaries)
  if (attestation.display) {
    formatted.displaySummary = attestation.display.tag || attestation.display;
  }

  // Create a human-readable summary
  formatted.summary = createHumanReadableSummary(formatted);

  return formatted;
}

/**
 * Create a human-readable summary from the formatted attestation
 */
function createHumanReadableSummary(formatted: any): string {
  const parts: string[] = [];
  
  const controlName = formatted.control?.name || formatted.control?.path || 'Unknown control';
  const assetName = formatted.asset?.name || formatted.asset?.uuid || 'Unknown asset';
  
  parts.push(`**${controlName}** for ${assetName}`);
  
  if (formatted.result) {
    parts.push(`Result: ${formatted.result.toUpperCase()}`);
  }
  
  if (formatted.measuredValue && formatted.threshold) {
    parts.push(`Measured: ${formatted.measuredValue} | Threshold: ${formatted.threshold}`);
  } else if (formatted.evaluationSummary) {
    parts.push(formatted.evaluationSummary);
  }
  
  return parts.join('\n');
}

/**
 * Generate insights for org-wide control status
 */
function generateControlInsights(
  controlPath: string,
  results: { passing: any[]; failing: any[] },
  passRate: number
): string[] {
  const insights: string[] = [];
  
  const total = results.passing.length + results.failing.length;
  
  if (total === 0) {
    insights.push(`⚠️ No attestations found for control "${controlPath}"`);
    return insights;
  }
  
  // Pass rate insight
  if (passRate === 100) {
    insights.push(`✅ All ${total} asset(s) passing "${controlPath}"`);
  } else if (passRate >= 80) {
    insights.push(`🟢 Good: ${passRate}% pass rate (${results.passing.length}/${total} assets)`);
  } else if (passRate >= 50) {
    insights.push(`🟡 Needs attention: ${passRate}% pass rate (${results.failing.length} failing)`);
  } else {
    insights.push(`🔴 Critical: Only ${passRate}% pass rate (${results.failing.length} assets failing)`);
  }
  
  // Failing assets insight
  if (results.failing.length > 0 && results.failing.length <= 3) {
    const failingNames = results.failing.map(f => f.asset).join(', ');
    insights.push(`❌ Failing in: ${failingNames}`);
  } else if (results.failing.length > 3) {
    insights.push(`❌ Failing in ${results.failing.length} assets - use get_asset_compliance_status for details`);
  }
  
  return insights;
}

