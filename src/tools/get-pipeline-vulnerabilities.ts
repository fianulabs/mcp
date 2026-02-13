import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_pipeline_vulnerabilities tool
 * Answers: "Show me all critical vulnerabilities introduced by the last pipeline run for [repo]"
 */
export const GetPipelineVulnerabilitiesSchema = z.object({
  assetIdentifier: z.string().describe('Repository name or UUID'),
  commit: z.string().optional().describe('Specific commit SHA to check. If not provided, uses the latest commit on the branch.'),
  branch: z.string().optional().describe('Branch to check (defaults to default branch, e.g., "main")'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'all']).optional().describe('Filter by severity level. Defaults to "all".'),
  showIntroduced: z.boolean().optional().describe('Only set to true when the user explicitly asks about "new", "introduced", or "added" vulnerabilities. For general vulnerability queries, leave as false (default). When true, compares with previous commit to calculate delta.'),
});

export type GetPipelineVulnerabilitiesParams = z.infer<typeof GetPipelineVulnerabilitiesSchema>;

/**
 * Control paths that indicate vulnerability/security scan results
 */
const VULNERABILITY_CONTROL_PATTERNS = [
  'sast',           // SAST scans (cycode.sast.*, checkmarx.sast.*, snyk.sast.*)
  'sca',            // SCA/dependency scans (snyk.sca.*, etc.)
  'secret',         // Secret detection (cycode.secret.*, etc.)
  'containerscan',  // Container scans (wiz.containerscan.*, etc.)
  'vulnerabilities',// Generic vulnerability controls
  'code_scanning',  // GitHub code scanning
  'dependabot',     // Dependabot alerts
  'dast',           // DAST scans
];

/**
 * Map control path patterns to human-readable scan types
 */
function getScanType(controlPath: string): string {
  const path = controlPath.toLowerCase();
  if (path.includes('sast')) return 'SAST';
  if (path.includes('sca')) return 'SCA';
  if (path.includes('secret')) return 'Secrets';
  if (path.includes('containerscan') || path.includes('container')) return 'Container';
  if (path.includes('dast')) return 'DAST';
  if (path.includes('dependabot')) return 'Dependencies';
  if (path.includes('code_scanning')) return 'Code Scanning';
  return 'Security';
}

/**
 * Check if a control path is vulnerability-related
 */
function isVulnerabilityControl(controlPath: string): boolean {
  if (!controlPath) return false;
  const path = controlPath.toLowerCase();
  return VULNERABILITY_CONTROL_PATTERNS.some(pattern => path.includes(pattern));
}

/**
 * Parse vulnerability details from the unstructured attestation detail field
 * Different scan tools store data differently, so we need to handle multiple formats
 */
function parseVulnerabilityDetails(detail: any, controlPath: string): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
  findings?: any[];
  rawDetail?: any;
} {
  if (!detail) {
    return { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
  }

  // Format 1: Direct severity counts (common format)
  if (typeof detail.critical === 'number' || typeof detail.high === 'number') {
    const critical = detail.critical || 0;
    const high = detail.high || 0;
    const medium = detail.medium || 0;
    const low = detail.low || 0;
    const info = detail.info || detail.informational || 0;
    return {
      critical,
      high,
      medium,
      low,
      info,
      total: critical + high + medium + low + info,
    };
  }

  // Format 2: Vulnerabilities array with severity field
  if (Array.isArray(detail.vulnerabilities)) {
    const findings = detail.vulnerabilities;
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    
    for (const vuln of findings) {
      const severity = (vuln.severity || vuln.level || '').toLowerCase();
      if (severity === 'critical') counts.critical++;
      else if (severity === 'high') counts.high++;
      else if (severity === 'medium' || severity === 'moderate') counts.medium++;
      else if (severity === 'low') counts.low++;
      else counts.info++;
    }
    
    return {
      ...counts,
      total: findings.length,
      findings: findings.slice(0, 10), // Limit to first 10 for context
    };
  }

  // Format 3: Issues array (GitHub code scanning, etc.)
  if (Array.isArray(detail.issues)) {
    const findings = detail.issues;
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    
    for (const issue of findings) {
      const severity = (issue.severity || issue.security_severity_level || '').toLowerCase();
      if (severity === 'critical') counts.critical++;
      else if (severity === 'high') counts.high++;
      else if (severity === 'medium' || severity === 'moderate') counts.medium++;
      else if (severity === 'low') counts.low++;
      else counts.info++;
    }
    
    return {
      ...counts,
      total: findings.length,
      findings: findings.slice(0, 10),
    };
  }

  // Format 4: Secrets array (secret detection)
  if (Array.isArray(detail.secrets)) {
    const findings = detail.secrets;
    // Secrets are typically all high/critical severity
    return {
      critical: 0,
      high: findings.length,
      medium: 0,
      low: 0,
      info: 0,
      total: findings.length,
      findings: findings.slice(0, 10),
    };
  }

  // Format 5: Alerts count (dependabot, etc.)
  if (typeof detail.alerts === 'number') {
    return {
      critical: 0,
      high: 0,
      medium: detail.alerts,
      low: 0,
      info: 0,
      total: detail.alerts,
    };
  }

  // Format 6: Count field
  if (typeof detail.count === 'number') {
    return {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      total: detail.count,
      rawDetail: detail,
    };
  }

  // Format 7: Total field
  if (typeof detail.total === 'number') {
    return {
      critical: detail.critical || 0,
      high: detail.high || 0,
      medium: detail.medium || 0,
      low: detail.low || 0,
      info: detail.info || 0,
      total: detail.total,
    };
  }

  // Format 8: Cycode detections array
  if (Array.isArray(detail.detections)) {
    const findings = detail.detections;
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    
    for (const detection of findings) {
      const severity = (detection.severity || detection.detection_type_severity || '').toLowerCase();
      if (severity === 'critical') counts.critical++;
      else if (severity === 'high') counts.high++;
      else if (severity === 'medium' || severity === 'moderate') counts.medium++;
      else if (severity === 'low') counts.low++;
      else counts.info++;
    }
    
    return {
      ...counts,
      total: findings.length,
      findings: findings.slice(0, 10).map(d => ({
        type: d.detection_type || d.type,
        severity: d.severity || d.detection_type_severity,
        message: d.message || d.detection_type_name,
        file: d.file_path || d.file,
        line: d.line_number || d.line,
      })),
    };
  }

  // Format 9: Cycode secrets_count or detections_count
  if (typeof detail.secrets_count === 'number' || typeof detail.detections_count === 'number') {
    const total = detail.secrets_count || detail.detections_count || 0;
    return {
      critical: 0,
      high: total, // Secrets are typically high severity
      medium: 0,
      low: 0,
      info: 0,
      total,
    };
  }

  // Format 10: Nested results object (common in scan tools)
  if (detail.results && typeof detail.results === 'object') {
    // Try to extract from results
    if (Array.isArray(detail.results)) {
      const findings = detail.results;
      const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      
      for (const result of findings) {
        const severity = (result.severity || result.level || '').toLowerCase();
        if (severity === 'critical') counts.critical++;
        else if (severity === 'high') counts.high++;
        else if (severity === 'medium' || severity === 'moderate') counts.medium++;
        else if (severity === 'low') counts.low++;
        else counts.info++;
      }
      
      return {
        ...counts,
        total: findings.length,
        findings: findings.slice(0, 10),
      };
    }
    // Results might have severity counts directly
    if (typeof detail.results.critical === 'number' || typeof detail.results.high === 'number') {
      return {
        critical: detail.results.critical || 0,
        high: detail.results.high || 0,
        medium: detail.results.medium || 0,
        low: detail.results.low || 0,
        info: detail.results.info || 0,
        total: (detail.results.critical || 0) + (detail.results.high || 0) + 
               (detail.results.medium || 0) + (detail.results.low || 0) + (detail.results.info || 0),
      };
    }
  }

  // Format 11: Summary object with counts
  if (detail.summary && typeof detail.summary === 'object') {
    const s = detail.summary;
    if (typeof s.critical === 'number' || typeof s.high === 'number' || typeof s.total === 'number') {
      return {
        critical: s.critical || 0,
        high: s.high || 0,
        medium: s.medium || 0,
        low: s.low || 0,
        info: s.info || 0,
        total: s.total || ((s.critical || 0) + (s.high || 0) + (s.medium || 0) + (s.low || 0)),
      };
    }
  }

  // Fallback: return the raw detail for inspection (truncated to avoid huge responses)
  const rawDetail = JSON.stringify(detail).length > 500 
    ? { _truncated: true, _keys: Object.keys(detail), _sample: JSON.stringify(detail).substring(0, 500) }
    : detail;
    
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    total: 0,
    rawDetail,
  };
}

/**
 * Get all critical vulnerabilities introduced by the last pipeline run for a repository
 * 
 * This tool answers: "Show me all critical vulnerabilities introduced by the last pipeline run for [repo]"
 * 
 * Key concepts:
 * - "Last pipeline run" = latest commit with security scan attestations (or specified commit)
 * - "Vulnerabilities" = findings from SAST, SCA, secret detection, container scans, etc.
 * - "Introduced" = new findings not present in the previous commit (optional delta analysis)
 * 
 * Transparency:
 * - We parse vulnerability data from attestation detail fields (unstructured)
 * - Different scan tools have different formats
 * - Delta analysis compares consecutive commits with attestations
 */
export async function getPipelineVulnerabilities(
  consulta: ConsultaClient,
  params: GetPipelineVulnerabilitiesParams
) {
  const { assetIdentifier, commit, branch, severity = 'all', showIntroduced = false } = params;

  console.log(`getPipelineVulnerabilities: asset=${assetIdentifier}, commit=${commit || 'latest'}, branch=${branch || 'default'}, severity=${severity}, showIntroduced=${showIntroduced}`);

  // Step 1: Resolve asset context (asset UUID, commit, branch)
  const context = await consulta.resolveAssetContext(assetIdentifier, { branch, commit });

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

  if (!context.resolvedCommit) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'No commits found',
          message: `Could not find any commits for asset: ${context.assetName}`,
          asset: {
            name: context.assetName,
            uuid: context.assetUuid,
          },
          suggestions: [
            'This asset may not have any commits tracked yet',
            'Check if the repository is properly configured in Fianu',
          ],
        }, null, 2)
      }],
    };
  }

  // Step 2: Get all attestations for this commit
  const attestations = await consulta.getAssetAttestations(
    assetIdentifier,
    undefined, // No control path filter - we'll filter client-side
    context.resolvedCommit,
    undefined,
    context.resolvedBranch || undefined
  );

  // Step 3: Filter to vulnerability-related attestations
  const vulnerabilityAttestations = attestations.filter(att => {
    const controlPath = att.control?.path || att.path || att.tag || '';
    return isVulnerabilityControl(controlPath);
  });

  if (vulnerabilityAttestations.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: {
            asset: context.assetName,
            assetUuid: context.assetUuid,
            commit: context.resolvedCommit,
            commitShort: context.resolvedCommit?.substring(0, 7),
            branch: context.resolvedBranch || context.defaultBranch,
            status: 'no_security_scans',
          },
          message: 'No security scan attestations found for this commit',
          suggestions: [
            'Security scans may not have run for this commit yet',
            'Check if SAST/SCA/secret detection is configured in your pipeline',
            'Try a different commit or branch',
          ],
          note: 'Security scans include: SAST, SCA, secret detection, container scans, code scanning',
        }, null, 2)
      }],
    };
  }

  // Step 4: Fetch full details for each vulnerability attestation and parse findings
  const scanResults: Array<{
    scanType: string;
    controlPath: string;
    controlName: string;
    result: string;
    findings: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
      total: number;
    };
    threshold?: string;
    attestationUuid: string;
    timestamp?: string;
    rawFindings?: any[];
  }> = [];

  let totalCritical = 0;
  let totalHigh = 0;
  let totalMedium = 0;
  let totalLow = 0;
  let totalInfo = 0;

  for (const att of vulnerabilityAttestations) {
    // The attestation from getAssetAttestations already has full details including the detail field
    // Use it directly - no need to fetch again unless uuid is present and detail is missing
    let details = att;
    
    // Only fetch full details if we have a UUID but no detail field
    if (att.uuid && !att.detail) {
      const fetchedDetails = await consulta.getAttestationDetails(att.uuid);
      if (fetchedDetails) {
        details = fetchedDetails;
      }
    }
    
    const controlPath = details?.producer?.entity?.path || 
                       details?.control?.path || 
                       att.control?.path || 
                       att.path || 
                       att.tag || 
                       'unknown';
    
    const controlName = details?.producer?.entity?.name || 
                       details?.control?.name || 
                       att.control?.name || 
                       controlPath;

    // Parse vulnerability details from the unstructured detail field
    // The detail field should be directly on the attestation object
    const detailField = details?.detail || att.detail;
    const vulnDetails = parseVulnerabilityDetails(detailField, controlPath);
    
    // Debug: show what fields we have in the full attestation details
    const availableFields = details ? Object.keys(details) : [];
    
    // If we couldn't parse the detail, include debug info
    if (vulnDetails.total === 0) {
      vulnDetails.rawDetail = {
        _availableFields: availableFields,
        _hasDetail: !!detailField,
        _detailKeys: detailField ? Object.keys(detailField) : [],
        _detailSample: detailField ? JSON.stringify(detailField).substring(0, 500) : null,
      };
    }

    // Accumulate totals
    totalCritical += vulnDetails.critical;
    totalHigh += vulnDetails.high;
    totalMedium += vulnDetails.medium;
    totalLow += vulnDetails.low;
    totalInfo += vulnDetails.info;

    // Extract threshold from policy if available
    let threshold: string | undefined;
    if (details?.policy?.data) {
      // Look for common threshold patterns
      const thresholdKeys = ['maximum', 'max', 'threshold', 'limit'];
      for (const [key, value] of Object.entries(details.policy.data)) {
        if (typeof value === 'object' && value !== null) {
          for (const tk of thresholdKeys) {
            if (tk in (value as any)) {
              threshold = `${key}: max ${(value as any)[tk]}`;
              break;
            }
          }
        }
      }
    }

    scanResults.push({
      scanType: getScanType(controlPath),
      controlPath,
      controlName,
      result: details?.result || att.result || 'unknown',
      findings: {
        critical: vulnDetails.critical,
        high: vulnDetails.high,
        medium: vulnDetails.medium,
        low: vulnDetails.low,
        info: vulnDetails.info,
        total: vulnDetails.total,
      },
      threshold,
      attestationUuid: att.uuid,
      timestamp: details?.timestamp || att.timestamp,
      rawFindings: vulnDetails.findings,
      // Include raw detail if we couldn't parse it (for debugging)
      ...(vulnDetails.rawDetail ? { unparsedDetail: vulnDetails.rawDetail } : {}),
    });
  }

  // Step 5: Apply severity filter
  let filteredResults = scanResults;
  if (severity !== 'all') {
    filteredResults = scanResults.filter(sr => {
      switch (severity) {
        case 'critical': return sr.findings.critical > 0;
        case 'high': return sr.findings.critical > 0 || sr.findings.high > 0;
        case 'medium': return sr.findings.critical > 0 || sr.findings.high > 0 || sr.findings.medium > 0;
        case 'low': return sr.findings.total > 0;
        default: return true;
      }
    });
  }

  // Step 6: Optional delta analysis (showIntroduced=true)
  // DELTA METHODOLOGY: Compare vulnerability counts between consecutive commits
  // - This shows "introduced" vulnerabilities (new findings in current vs previous)
  // - Count-based approximation: actual individual vulnerabilities may differ
  // - Use this when user asks about "new", "introduced", or "added" vulnerabilities
  let introduced: any = undefined;
  if (showIntroduced) {
    try {
      // Find the previous commit with scan attestations
      const commits = await consulta.getAssetCommits(context.assetUuid);
      const currentIndex = commits.findIndex((c: any) => c.commit === context.resolvedCommit);

      if (currentIndex >= 0 && currentIndex < commits.length - 1) {
        const previousCommit = commits[currentIndex + 1]?.commit;

        if (previousCommit) {
          // Fetch vulnerability attestations from previous commit
          const previousAttestations = await consulta.getAssetAttestations(
            assetIdentifier,
            undefined,
            previousCommit
          );

          // Filter to security scan controls only
          const previousVulnAttestations = previousAttestations.filter(att => {
            const controlPath = att.control?.path || att.path || att.tag || '';
            return isVulnerabilityControl(controlPath);
          });

          // Aggregate vulnerability counts from previous commit
          let prevCritical = 0;
          let prevHigh = 0;
          let prevMedium = 0;
          let prevLow = 0;

          for (const att of previousVulnAttestations) {
            const details = await consulta.getAttestationDetails(att.uuid);
            const vulnDetails = parseVulnerabilityDetails(details?.detail, att.control?.path || '');
            prevCritical += vulnDetails.critical;
            prevHigh += vulnDetails.high;
            prevMedium += vulnDetails.medium;
            prevLow += vulnDetails.low;
          }

          // Calculate delta (current - previous)
          // Positive numbers indicate new findings, negative indicate resolved
          introduced = {
            methodology: `Compared vulnerability counts between current commit (${context.resolvedCommit?.substring(0, 7)}) and previous commit (${previousCommit.substring(0, 7)}). Shows the difference in finding counts.`,
            comparedWith: {
              commit: previousCommit,
              commitShort: previousCommit.substring(0, 7),
            },
            delta: {
              critical: totalCritical - prevCritical,
              high: totalHigh - prevHigh,
              medium: totalMedium - prevMedium,
              low: totalLow - prevLow,
            },
            note: 'Positive numbers indicate new findings. This is an approximation based on count differences, not individual vulnerability tracking.',
          };
        }
      }
      
      if (!introduced) {
        introduced = {
          error: 'Could not find previous commit for comparison',
          note: 'Delta analysis requires at least two commits with security scan data',
        };
      }
    } catch (e) {
      console.warn('Delta analysis failed:', e);
      introduced = {
        error: 'Delta analysis failed',
        note: String(e),
      };
    }
  }

  // Step 7: Determine overall status
  let status: string;
  if (totalCritical > 0) {
    status = 'has_critical';
  } else if (totalHigh > 0) {
    status = 'has_high';
  } else if (totalMedium > 0 || totalLow > 0) {
    status = 'has_vulnerabilities';
  } else {
    status = 'clean';
  }

  // Step 8: Generate insights
  const insights: string[] = [];
  
  if (totalCritical > 0) {
    insights.push(`🚨 ${totalCritical} CRITICAL vulnerabilit${totalCritical === 1 ? 'y' : 'ies'} detected - immediate attention required`);
  }
  if (totalHigh > 0) {
    insights.push(`⚠️ ${totalHigh} HIGH severity finding${totalHigh === 1 ? '' : 's'} - should be addressed soon`);
  }
  if (totalMedium > 0) {
    insights.push(`📊 ${totalMedium} MEDIUM severity finding${totalMedium === 1 ? '' : 's'}`);
  }
  if (totalLow > 0) {
    insights.push(`📝 ${totalLow} LOW severity finding${totalLow === 1 ? '' : 's'}`);
  }
  if (status === 'clean') {
    insights.push('✅ No vulnerabilities detected in security scans');
  }
  
  // Add scan type breakdown
  const scanTypes = [...new Set(filteredResults.map(sr => sr.scanType))];
  if (scanTypes.length > 0) {
    insights.push(`📋 Scans performed: ${scanTypes.join(', ')}`);
  }
  
  // Add failing scans
  const failingScans = filteredResults.filter(sr => sr.result === 'fail');
  if (failingScans.length > 0) {
    insights.push(`❌ ${failingScans.length} scan${failingScans.length === 1 ? '' : 's'} failed policy thresholds`);
  }

  // Step 9: Build response
  const response: any = {
    summary: {
      asset: context.assetName,
      assetUuid: context.assetUuid,
      commit: context.resolvedCommit,
      commitShort: context.resolvedCommit?.substring(0, 7),
      branch: context.resolvedBranch || context.defaultBranch,
      timestamp: filteredResults[0]?.timestamp,
      status,
      totalFindings: totalCritical + totalHigh + totalMedium + totalLow + totalInfo,
      bySeverity: {
        critical: totalCritical,
        high: totalHigh,
        medium: totalMedium,
        low: totalLow,
        info: totalInfo,
      },
    },
    scanResults: filteredResults.map(sr => ({
      scanType: sr.scanType,
      controlPath: sr.controlPath,
      controlName: sr.controlName,
      result: sr.result,
      findings: sr.findings,
      threshold: sr.threshold,
      attestationUuid: sr.attestationUuid,
    })),
    insights,
  };

  // Add introduced section if requested
  if (showIntroduced && introduced) {
    response.introduced = introduced;
  }

  // Add transparency notes
  response.notes = [
    'Vulnerability details parsed from attestation data. Counts reflect what was reported by scan tools.',
    'For detailed finding information (file locations, remediation), consult original scan reports.',
    severity !== 'all' ? `Filtered to show only ${severity.toUpperCase()} severity and above.` : null,
  ].filter(Boolean);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(response, null, 2)
    }],
  };
}

