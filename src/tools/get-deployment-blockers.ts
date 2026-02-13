import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * A control that is blocking deployment
 */
interface BlockingControl {
  controlPath: string;
  controlName: string;
  reason: string;
  severity?: string;
  attestationUuid?: string;
  result?: string;
}

/**
 * An asset with blocking controls
 */
interface BlockedAsset {
  assetUuid: string;
  assetName: string;
  assetType: string;
  failingControls: BlockingControl[];
  passingControls: number;
  totalControls: number;
}

/**
 * Pending release information
 */
interface PendingRelease {
  uuid: string;
  name: string;
  status: string;
  targetEnvironment?: string;
  targetGate?: string;
  createdAt?: string;
}

/**
 * Response from get_deployment_blockers tool
 */
interface DeploymentBlockersResponse {
  application: {
    name: string;
    code?: string;
    uuid: string;
    type: string;
  };
  targetGate: {
    name: string;
    entityKey: string;
  };
  /** Information about pending releases discovered */
  pendingReleases?: PendingRelease[];
  /** The specific release being checked (if any) */
  release?: PendingRelease;
  canDeploy: boolean;
  summary: string;
  blockedAssets: BlockedAsset[];
  passingAssets: Array<{
    assetUuid: string;
    assetName: string;
    assetType: string;
    passingControls: number;
  }>;
  totalBlockers: number;
  query: {
    applicationName: string;
    targetEnvironment: string;
    checkPendingReleases?: boolean;
  };
  insights: string[];
  recommendations: string[];
}

/**
 * Handler for the get_deployment_blockers tool
 * 
 * Answers: "What's blocking [application] from deploying to [environment]?"
 * 
 * This tool:
 * 1. Resolves the application by name/code
 * 2. Gets the gate requirements for the target environment
 * 3. Checks compliance for each asset in the application
 * 4. Reports which controls are blocking deployment
 */
export const getDeploymentBlockersHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<DeploymentBlockersResponse> => {
  const client = new ConsultaClient(env, session);
  const startTime = Date.now();
  
  const applicationName = args.applicationName as string;
  const targetEnvironment = (args.targetEnvironment as string) || 'production';
  
  if (!applicationName) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'applicationName is required',
          message: 'Please provide the application name or code (e.g., "DBX" or "Digital Banking Experience")',
        }, null, 2)
      }],
    } as any;
  }
  
  console.log(`[get_deployment_blockers] Starting: app=${applicationName}, target=${targetEnvironment}`);
  
  try {
    // Step 1: Resolve application using shared method (handles app codes like "DBX")
    const resolved = await client.resolveApplication(applicationName);
    
    let matchedApp: any = null;
    let isDirectAsset = false;
    let directAsset: { uuid: string; name: string; type: string } | null = null;
    
    if (resolved.found) {
      // Found an application - use the raw data for full access
      matchedApp = resolved.raw;
      console.log(`[get_deployment_blockers] Resolved app: ${resolved.name} (code: ${resolved.code})`);
    } else {
      // If no application found, check if it's a repository/asset name
      const orgCompliance = await client.getOrganizationCompliance();
      const searchLower = applicationName.toLowerCase();
      
      for (const app of orgCompliance) {
        for (const asset of app.assets || []) {
          if (asset.name?.toLowerCase().includes(searchLower) ||
              asset.repository?.toLowerCase().includes(searchLower) ||
              asset.uuid?.toLowerCase() === searchLower) {
            directAsset = {
              uuid: asset.uuid,
              name: asset.name || asset.repository || asset.uuid,
              type: asset.type || 'repository',
            };
            // Use the parent app for context
            matchedApp = app;
            isDirectAsset = true;
            break;
          }
        }
        if (directAsset) break;
      }
      
      if (!directAsset) {
        // Get available apps for hints
        const availableApps = await client.listAvailableApplications();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Application or asset not found',
              message: `Could not find application or repository matching "${applicationName}"`,
              hint: 'Try using the exact repository name or an application code like "DBX"',
              availableApplications: availableApps.slice(0, 10),
            }, null, 2)
          }],
        } as any;
      }
    }
    
    const assetDisplayName = isDirectAsset ? directAsset!.name : (matchedApp.app_name || matchedApp.app_code);
    console.log(`[get_deployment_blockers] Found ${isDirectAsset ? 'repository' : 'application'}: ${assetDisplayName}`);
    
    // Step 2: Get the target gate and its requirements
    const gates = await client.listGates();
    const targetGate = gates.find(g => 
      g.entityKey?.toLowerCase().includes(targetEnvironment.toLowerCase()) ||
      g.name?.toLowerCase().includes(targetEnvironment.toLowerCase())
    );
    
    if (!targetGate) {
      // If no exact match, use the application's assets to check compliance
      console.log(`[get_deployment_blockers] No gate found for "${targetEnvironment}", checking general compliance`);
    }
    
    const gateEntityKey = targetGate?.entityKey || targetEnvironment;
    const gateName = targetGate?.name || targetEnvironment;
    
    // Step 3: Get required controls for the gate
    let gateControls = new Map<string, any>();
    if (targetGate) {
      gateControls = await client.getGateRequiredControls(gateEntityKey);
      console.log(`[get_deployment_blockers] Gate "${gateName}" requires ${gateControls.size} controls`);
    }
    
    // Step 4: Check compliance for each asset in the application
    const blockedAssets: BlockedAsset[] = [];
    const passingAssets: Array<{ assetUuid: string; assetName: string; assetType: string; passingControls: number }> = [];
    
    // Get all assets to check
    const assetsToCheck: Array<{ uuid: string; name: string; type: string }> = [];
    
    if (isDirectAsset && directAsset) {
      // Single repository/asset - just check that one
      assetsToCheck.push(directAsset);
    } else {
      // Application - check all child assets
      // Add child assets (repositories, modules) first
      for (const asset of matchedApp.assets || []) {
        if (asset.uuid) {
          assetsToCheck.push({
            uuid: asset.uuid,
            name: asset.name || asset.repository || asset.uuid,
            type: asset.type || 'repository',
          });
        }
      }
      
      // If no child assets found, check the application identifier itself
      // This handles cases where the app has data but assets array is empty/different structure
      if (assetsToCheck.length === 0 && (matchedApp.identifier || matchedApp.version_uuid)) {
        assetsToCheck.push({
          uuid: matchedApp.identifier || matchedApp.version_uuid,
          name: matchedApp.app_name || matchedApp.app_code,
          type: matchedApp.type || 'application',
        });
      }
    }
    
    console.log(`[get_deployment_blockers] Checking ${assetsToCheck.length} assets`);
    
    // Check each asset's compliance
    for (const asset of assetsToCheck) {
      try {
        const compliance = await client.getAssetCompliance(asset.uuid);
        
        if (!compliance || !compliance.controls) {
          continue;
        }
        
        const failingControls: BlockingControl[] = [];
        let passingCount = 0;
        
        for (const control of compliance.controls) {
          // If we have gate requirements, only check those controls
          // Otherwise check all required controls
          const isRequired = control.required !== false && 
            (gateControls.size === 0 || gateControls.has(control.controlPath));
          
          if (!isRequired) continue;
          
          if (control.status === 'fail' || control.result === 'fail') {
            failingControls.push({
              controlPath: control.controlPath || control.path,
              controlName: control.name || control.controlPath,
              reason: control.failureReason || control.detail || `Control failed evaluation`,
              severity: control.severity,
              attestationUuid: control.attestationUuid,
              result: control.result || control.status,
            });
          } else if (control.status === 'not_found') {
            // Missing evidence for required control is also a blocker
            failingControls.push({
              controlPath: control.controlPath || control.path,
              controlName: control.name || control.controlPath,
              reason: `No evidence found - required control has no attestations`,
              severity: control.severity,
              result: 'missing',
            });
          } else if (control.status === 'pass' || control.result === 'pass' || control.status === 'passing') {
            passingCount++;
          }
        }
        
        if (failingControls.length > 0) {
          blockedAssets.push({
            assetUuid: asset.uuid,
            assetName: asset.name,
            assetType: asset.type,
            failingControls,
            passingControls: passingCount,
            totalControls: failingControls.length + passingCount,
          });
        } else if (passingCount > 0) {
          passingAssets.push({
            assetUuid: asset.uuid,
            assetName: asset.name,
            assetType: asset.type,
            passingControls: passingCount,
          });
        }
      } catch (assetError) {
        console.warn(`[get_deployment_blockers] Failed to check asset ${asset.name}:`, assetError);
      }
    }
    
    // Calculate totals
    const totalBlockers = blockedAssets.reduce((sum, a) => sum + a.failingControls.length, 0);
    const canDeploy = totalBlockers === 0;
    
    // Generate summary
    let summary: string;
    if (canDeploy) {
      summary = `${matchedApp.app_name} can deploy to ${gateName}: All required controls passing`;
    } else {
      const blockerAssetNames = blockedAssets.map(a => a.assetName).join(', ');
      summary = `${matchedApp.app_name} CANNOT deploy to ${gateName}: ${totalBlockers} control(s) failing in ${blockedAssets.length} asset(s) (${blockerAssetNames})`;
    }
    
    // Generate insights
    const insights: string[] = [];
    
    if (canDeploy) {
      insights.push(`✅ All ${passingAssets.length} assets are compliant for ${gateName} deployment`);
    } else {
      insights.push(`❌ ${blockedAssets.length} of ${assetsToCheck.length} assets have blocking issues`);
      
      // Most common failing control
      const controlCounts = new Map<string, number>();
      for (const asset of blockedAssets) {
        for (const ctrl of asset.failingControls) {
          controlCounts.set(ctrl.controlPath, (controlCounts.get(ctrl.controlPath) || 0) + 1);
        }
      }
      
      const sortedControls = Array.from(controlCounts.entries()).sort((a, b) => b[1] - a[1]);
      if (sortedControls.length > 0) {
        const [topControl, count] = sortedControls[0];
        insights.push(`Most common blocker: ${topControl} (failing in ${count} asset(s))`);
      }
    }
    
    if (gateControls.size > 0) {
      insights.push(`${gateName} gate requires ${gateControls.size} controls`);
    }
    
    // Generate recommendations
    const recommendations: string[] = [];
    
    if (!canDeploy) {
      // Group by control for actionable recommendations
      const controlIssues = new Map<string, string[]>();
      for (const asset of blockedAssets) {
        for (const ctrl of asset.failingControls) {
          if (!controlIssues.has(ctrl.controlPath)) {
            controlIssues.set(ctrl.controlPath, []);
          }
          controlIssues.get(ctrl.controlPath)!.push(asset.assetName);
        }
      }
      
      for (const [controlPath, assets] of controlIssues) {
        if (assets.length === 1) {
          recommendations.push(`Fix ${controlPath} in ${assets[0]}`);
        } else {
          recommendations.push(`Fix ${controlPath} in ${assets.length} assets: ${assets.slice(0, 3).join(', ')}${assets.length > 3 ? '...' : ''}`);
        }
      }
      
      recommendations.push(`Use get_attestation_details to see specific failure reasons`);
      recommendations.push(`Use get_policy_violations for detailed violation context`);
    } else {
      recommendations.push(`Ready to deploy - proceed with release process`);
    }
    
    const response: DeploymentBlockersResponse = {
      application: {
        name: isDirectAsset ? directAsset!.name : (matchedApp.app_name || applicationName),
        code: isDirectAsset ? undefined : matchedApp.app_code,
        uuid: isDirectAsset ? directAsset!.uuid : (matchedApp.identifier || matchedApp.version_uuid),
        type: isDirectAsset ? directAsset!.type : (matchedApp.type || 'application'),
      },
      targetGate: {
        name: gateName,
        entityKey: gateEntityKey,
      },
      canDeploy,
      summary,
      blockedAssets,
      passingAssets,
      totalBlockers,
      query: {
        applicationName,
        targetEnvironment,
      },
      insights,
      recommendations,
    };
    
    console.log(`[get_deployment_blockers] Completed in ${Date.now() - startTime}ms: canDeploy=${canDeploy}, blockers=${totalBlockers}`);
    
    // Return in MCP content format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    } as any;
    
  } catch (error) {
    console.error(`[get_deployment_blockers] Failed after ${Date.now() - startTime}ms:`, error);
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Failed to check deployment blockers',
          message: error instanceof Error ? error.message : 'Unknown error',
          query: { applicationName, targetEnvironment },
        }, null, 2)
      }],
    } as any;
  }
};

