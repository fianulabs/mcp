import type { Env, SessionState, ComplianceStatus, Control, ComplianceSummary } from '../types';

/**
 * API Response types for /evidence/assets/compliance endpoint
 * Based on core/external/db/types/fianu/reporting/v0.0.1/applications.go
 */
interface ApplicationComplianceResponse {
  app_code: string;
  app_name: string;
  identifier: string;
  type: string;
  version_uuid: string;
  pagination: number;
  attestations: ApplicationComplianceAttestation[];
  assets: ApplicationComplianceAsset[];
}

interface ApplicationComplianceAsset {
  attestations: ApplicationComplianceAttestation[];
  commit: string;
  name: string;
  project: string;
  repository: string;
  type: string;
  uuid: string;
}

interface ApplicationComplianceAttestation {
  asset_commit: string;
  asset_uuid: string;
  entity_id: string;
  result: string;
  status: string;
  tag: string;
  uuid: string;
}

/**
 * Deployment record structure from the API
 */
interface DeploymentRecord {
  uuid: string;
  timestamp: string;
  commit: string;
  artifact?: string;
  tag?: string;
  environment: string;
  environmentName?: string;
  target?: string;
  targetName?: string;
  changeRecord?: string;
  status?: string;
  result?: string;
  evidence?: Array<{ note: string; metadata?: any }>;
}

/**
 * API Response type for /evidence/assets/:asset/attestations/snapshot endpoint
 * Based on core/external/db/types/fianu/reporting/v0.0.1/evidence.go
 */
interface AssetAttestationSnapshotResponse {
  asset: string;
  commit?: string;
  project?: string;
  repository?: string;
  repository_id?: string;
  count: number;
  assetName: string;
  assetType: string;
  instance: string;
  attestations: AttestationResult[];
}

interface AttestationResult {
  asset: string;
  uuid: string;
  result: string; // 'pass' or 'fail'
  type: string;
  artifact?: string;
  apiVersion: string;
  annotated: boolean;
  control: {
    uuid?: string;
    path?: string;
    name?: string;
    version?: {
      semantic: string;
      status: string;
      uuid: string;
    };
  };
  policy?: {
    type: string;
    uuid: string;
  };
  sequence: Array<{
    path: string;
    type: string;
    uuid: string;
  }>;
}

/**
 * Control status type for aggregated compliance
 */
interface ControlStatus {
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

/**
 * Resolved asset context - the foundational data needed by all tools
 * This is the result of resolving asset name, branch, and commit to their canonical forms
 */
export interface ResolvedAssetContext {
  /** Original asset identifier provided by user */
  assetIdentifier: string;
  /** Resolved asset UUID */
  assetUuid: string;
  /** Human-readable asset name */
  assetName: string;
  /** Project name (for SCM assets) */
  projectName: string | null;
  /** Repository name (for SCM assets) */
  repositoryName: string | null;
  /** Application version UUID (if asset is part of an application) */
  applicationVersionUuid: string | null;
  /** Repository ID from /assets endpoint (if available) */
  repositoryId: string | null;
  /** Default branch for the repository */
  defaultBranch: string | null;
  /** The branch that was resolved (may be default if none specified) */
  resolvedBranch: string | null;
  /** The full 40-character commit SHA (resolved from short SHA or branch) */
  resolvedCommit: string | null;
  /** Original commit input (if any) */
  originalCommit: string | null;
  /** Original branch input (if any) */
  originalBranch: string | null;
  /** Debug information about resolution steps */
  debug?: {
    assetResolution?: any;
    branchResolution?: any;
    commitResolution?: any;
  };
}


/**
 * Release asset structure from /assets?type=release
 */
interface ReleaseAsset {
  uuid: string;
  name: string;
  type: 'release';
  status: 'pending' | 'released' | string;
  parent?: string;
  parentName?: string;
  key?: string;
  createdAt?: string;
  modifiedAt?: string;
  properties?: Array<{ key: string; value: any }>;
  lineage?: Array<{ 
    uuid: string; 
    name: string; 
    type: string;
    parent?: string;
  }>;
  targetEnvironment?: string;
  targetGate?: string;
  // Additional fields from release properties
  subtitle?: string;  // Contains comma-separated app names
  version?: string;   // From asset.release.version property
  releaseId?: string; // From asset.release.id property
}

/**
 * Client for interacting with Fianu Consulta API
 * Handles all data fetching, caching, and audit logging
 */
export class ConsultaClient {
  private baseUrl: string;
  private env: Env;
  private session: SessionState;

  constructor(env: Env, session: SessionState) {
    this.env = env;
    this.session = session;
    this.baseUrl = env.CONSULTA_URL.replace(/\/$/, ''); // Remove trailing slash
  }

  // =====================================================
  // FOUNDATIONAL RESOLVER: Asset, Branch, and Commit Resolution
  // This is the core resolution logic used by all tools
  // =====================================================

  /**
   * Resolve asset identifier, branch, and commit to their canonical forms.
   * This is the FOUNDATIONAL method that all tools should use to normalize inputs.
   * 
   * Resolution order:
   * 1. Asset name/UUID → Asset UUID, project, repository info
   * 2. If commit provided → Resolve short SHA to full SHA
   * 3. If branch provided (no commit) → Find latest commit on that branch
   * 4. If neither → Find latest commit on default branch
   * 
   * @param assetIdentifier - Asset name or UUID
   * @param options - Optional branch and commit parameters
   * @returns ResolvedAssetContext with all resolved values
   */
  async resolveAssetContext(
    assetIdentifier: string,
    options: { branch?: string; commit?: string } = {}
  ): Promise<ResolvedAssetContext> {
    const { branch, commit } = options;
    const debug: ResolvedAssetContext['debug'] = {};
    
    console.log(`[resolveAssetContext] Starting resolution: asset="${assetIdentifier}", branch="${branch || 'default'}", commit="${commit || 'latest'}"`);

    // Initialize result with defaults
    const result: ResolvedAssetContext = {
      assetIdentifier,
      assetUuid: '',
      assetName: assetIdentifier,
      projectName: null,
      repositoryName: null,
      applicationVersionUuid: null,
      repositoryId: null,
      defaultBranch: null,
      resolvedBranch: branch || null,
      resolvedCommit: commit || null,
      originalCommit: commit || null,
      originalBranch: branch || null,
      debug,
    };

    // Step 1: Resolve asset identifier to UUID and metadata
    // Uses fuzzy matching because users may provide partial names, codes, or identifiers
    // We search both application-level and asset-level fields to maximize match rate
    try {
      const complianceData = await this.fetch<ApplicationComplianceResponse[]>(`/evidence/assets/compliance`);
      const applications = Array.isArray(complianceData) ? complianceData : [];

      for (const app of applications) {
        // Try matching on application-level fields first (app_name, app_code, identifier)
        const appMatches =
          app.app_name?.toLowerCase().includes(assetIdentifier.toLowerCase()) ||
          app.app_code?.toLowerCase().includes(assetIdentifier.toLowerCase()) ||
          app.identifier?.toLowerCase().includes(assetIdentifier.toLowerCase());

        if (appMatches) {
          result.assetName = app.app_name || app.app_code || assetIdentifier;
          result.applicationVersionUuid = app.version_uuid || null;
          
          // Find the repository asset with project/repository info
          for (const asset of app.assets || []) {
            if (asset.type === 'repository' || asset.repository) {
              result.assetUuid = asset.uuid;
              result.projectName = asset.project || null;
              result.repositoryName = asset.repository || asset.name || null;
              break;
            }
          }
          
          // Fallback to first asset if no repository found
          if (!result.assetUuid && app.assets?.length > 0) {
            const firstAsset = app.assets[0];
            result.assetUuid = firstAsset.uuid;
            result.projectName = firstAsset.project || null;
            result.repositoryName = firstAsset.repository || firstAsset.name || null;
          }
          break;
        }
        
        // Also check nested assets
        for (const asset of app.assets || []) {
          const assetMatches = 
            asset.name?.toLowerCase().includes(assetIdentifier.toLowerCase()) ||
            asset.repository?.toLowerCase().includes(assetIdentifier.toLowerCase());
          
          if (assetMatches) {
            result.assetName = asset.name || assetIdentifier;
            result.assetUuid = asset.uuid;
            result.applicationVersionUuid = app.version_uuid || null;
            result.projectName = asset.project || null;
            result.repositoryName = asset.repository || asset.name || null;
            break;
          }
        }
        
        if (result.assetUuid) break;
      }
      
      debug.assetResolution = {
        found: !!result.assetUuid,
        assetUuid: result.assetUuid,
        assetName: result.assetName,
        projectName: result.projectName,
        repositoryName: result.repositoryName,
      };
      
      console.log(`[resolveAssetContext] Asset resolution: uuid=${result.assetUuid}, name=${result.assetName}`);
    } catch (e) {
      console.warn(`[resolveAssetContext] Failed to resolve asset: ${e}`);
      debug.assetResolution = { error: String(e) };
    }

    // If we couldn't find the asset, return early
    if (!result.assetUuid) {
      console.log(`[resolveAssetContext] Could not resolve asset "${assetIdentifier}"`);
      return result;
    }

    // Step 2: Get default branch and repository ID from /assets endpoint
    // Default branch is critical for Step 3 when no branch is specified
    try {
      const assetUrl = `/assets?repository=${encodeURIComponent(assetIdentifier)}`;
      const assetData = await this.fetch<any>(assetUrl);
      const assets = Array.isArray(assetData) ? assetData : [assetData];

      for (const asset of assets) {
        if (asset.scm?.defaultBranch) {
          result.defaultBranch = asset.scm.defaultBranch;
        }
        if (asset.repositoryId) {
          result.repositoryId = asset.repositoryId;
        }
        if (result.defaultBranch) break;
      }

      console.log(`[resolveAssetContext] Default branch: ${result.defaultBranch}, repositoryId: ${result.repositoryId}`);
    } catch (e) {
      console.log(`[resolveAssetContext] Could not get default branch: ${e}`);
    }

    // Step 3: Resolve commit - either from short SHA or from branch
    // This is the most complex step with two distinct paths
    if (result.assetUuid) {
      try {
        const commitsUrl = `/assets/${result.assetUuid}/commits`;
        const commitsData = await this.fetch<any[]>(commitsUrl);
        const commits = Array.isArray(commitsData) ? commitsData : [];

        console.log(`[resolveAssetContext] Found ${commits.length} commits for asset`);

        if (commit) {
          // Case A: User provided a commit SHA - resolve short SHA to full SHA (40 chars)
          // Git allows short SHAs (7+ chars), but Consulta APIs require full 40-char SHAs
          const isShortCommit = commit.length < 40;
          
          if (isShortCommit) {
            const matchingCommit = commits.find((c: any) => 
              c.commit && c.commit.toLowerCase().startsWith(commit.toLowerCase())
            );
            
            if (matchingCommit?.commit) {
              result.resolvedCommit = matchingCommit.commit;
              console.log(`[resolveAssetContext] Resolved short SHA "${commit}" to "${result.resolvedCommit}"`);
              debug.commitResolution = {
                type: 'short_to_full',
                shortCommit: commit,
                fullCommit: result.resolvedCommit,
                status: 'resolved',
              };
            } else {
              console.log(`[resolveAssetContext] Could not resolve short SHA "${commit}"`);
              debug.commitResolution = {
                type: 'short_to_full',
                shortCommit: commit,
                status: 'not_found',
                commitsChecked: commits.length,
              };
            }
          } else {
            // Full SHA provided - use as-is
            result.resolvedCommit = commit;
            debug.commitResolution = { type: 'full_sha', status: 'used_as_is' };
          }
        } else {
          // Case B: No commit provided - find latest commit on the specified/default branch
          // Fallback chain: user branch → default branch → 'main'
          const targetBranch = branch || result.defaultBranch || 'main';
          result.resolvedBranch = targetBranch;

          // Filter commits by branch - API returns commits with branch metadata
          // We check multiple fields because API response format varies
          const branchCommits = commits.filter((c: any) => {
            const commitBranch = c.branch || c.ref;
            const commitBranches = c.branches || c.refs || [];
            return (
              commitBranch === targetBranch ||
              commitBranches.includes(targetBranch) ||
              commitBranches.some((b: any) => b === targetBranch || b.name === targetBranch)
            );
          });

          // Use branch-filtered commits if available, otherwise fall back to all commits
          // This fallback handles cases where branch metadata is missing
          let targetCommits = branchCommits.length > 0 ? branchCommits : commits;

          // Sort by timestamp (newest first) to get the latest commit
          targetCommits.sort((a: any, b: any) => {
            const timeA = new Date(a.timestamp || a.created_at || a.date || 0).getTime();
            const timeB = new Date(b.timestamp || b.created_at || b.date || 0).getTime();
            return timeB - timeA;
          });

          if (targetCommits.length > 0 && targetCommits[0].commit) {
            result.resolvedCommit = targetCommits[0].commit;
            console.log(`[resolveAssetContext] Resolved branch "${targetBranch}" to latest commit: ${result.resolvedCommit}`);
            debug.branchResolution = {
              branch: targetBranch,
              latestCommit: result.resolvedCommit,
              commitsOnBranch: branchCommits.length,
              totalCommits: commits.length,
              status: 'resolved',
            };
          } else {
            console.log(`[resolveAssetContext] Could not find commits for branch "${targetBranch}"`);
            debug.branchResolution = {
              branch: targetBranch,
              status: 'no_commits_found',
              totalCommits: commits.length,
            };
          }
        }
      } catch (e) {
        console.warn(`[resolveAssetContext] Failed to resolve commit: ${e}`);
        debug.commitResolution = { error: String(e) };
      }
    }

    console.log(`[resolveAssetContext] Final result: asset=${result.assetUuid}, commit=${result.resolvedCommit}, branch=${result.resolvedBranch}`);
    return result;
  }

  /**
   * Enrich control status objects with human-readable names from the controls API
   * Uses /console/controls endpoint
   */
  private async enrichControlNames(controls: ControlStatus[]): Promise<void> {
    if (controls.length === 0) return;

    try {
      // Try to fetch control metadata from the console controls endpoint
      // The control UUID/entity_id can be looked up to get displayKey and path
      const controlsData = await this.fetch<any[]>(`/console/controls`).catch(() => []);
      
      // Build a lookup map of control UUID -> control info
      const controlMap = new Map<string, { name: string; displayKey: string; path: string; description: string }>();
      
      for (const control of controlsData || []) {
        const uuid = control.uuid || control.id;
        const entityId = control.entityId || control.entity_id;
        
        const info = {
          name: control.displayKey || control.name || control.path || uuid,
          displayKey: control.displayKey || '',
          path: control.path || '',
          description: control.description || control.detail?.description || '',
        };
        
        if (uuid) controlMap.set(uuid, info);
        if (entityId) controlMap.set(entityId, info);
        if (control.path) controlMap.set(control.path, info);
      }

      // Enrich each control status
      for (const control of controls) {
        // Try to find a match by UUID or name
        const lookup = controlMap.get(control.uuid) || 
                      controlMap.get(control.name) ||
                      controlMap.get(control.description?.replace('Control: ', ''));
        
        if (lookup) {
          control.name = lookup.displayKey || lookup.name || lookup.path;
          control.description = lookup.description || `Path: ${lookup.path}`;
        } else {
          // If no match found, try to make the UUID more readable
          // Check if the name is a UUID and try to extract a meaningful part
          if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(control.name)) {
            control.description = `Control ID: ${control.name}`;
          }
        }
      }

      console.log(`Enriched ${controls.length} controls with names`);
    } catch (error) {
      console.warn('Failed to enrich control names:', error);
      // Continue without enrichment - controls will show UUIDs
    }
  }

  /**
   * Search for an asset in the organization compliance data and extract its compliance info
   */
  private async getAssetFromOrgCompliance(searchTerm: string): Promise<ComplianceStatus | null> {
    try {
      const complianceData = await this.fetch<ApplicationComplianceResponse[]>(`/evidence/assets/compliance`);
      const applications = Array.isArray(complianceData) ? complianceData : [];
      const searchLower = searchTerm.toLowerCase();
      
      for (const app of applications) {
        // Check if this application matches
        if (app.app_name?.toLowerCase().includes(searchLower) ||
            app.app_code?.toLowerCase().includes(searchLower) ||
            app.identifier?.toLowerCase().includes(searchLower)) {
          
          console.log(`Found matching application: ${app.app_name || app.app_code}`);
          
          // Log first attestation to see its structure
          if (app.attestations?.length > 0) {
            console.log('Sample attestation structure:', JSON.stringify(app.attestations[0]));
          }
          
          // Count attestations
          let passing = 0;
          let failing = 0;
          const controlMap = new Map<string, ControlStatus & { attestationUuid?: string }>();
          
          for (const attestation of app.attestations || []) {
            const isPassing = attestation.status === 'pass' || attestation.result === 'pass';
            if (isPassing) passing++;
            else failing++;
            
            // Track by entity_id (control) - store attestation UUID for detail lookup
            const controlKey = attestation.entity_id || attestation.uuid;
            const attestationUuid = attestation.uuid || null;
            
            if (!controlMap.has(controlKey)) {
              controlMap.set(controlKey, {
                uuid: attestationUuid,
                name: controlKey,
                description: `Control: ${controlKey}`,
                status: isPassing ? 'passing' : 'failing',
                severity: 'medium',
                passingChecks: isPassing ? 1 : 0,
                failingChecks: isPassing ? 0 : 1,
                totalChecks: 1,
                attestationUuid: attestationUuid,
              });
            } else {
              const existing = controlMap.get(controlKey)!;
              if (isPassing) existing.passingChecks++;
              else {
                existing.failingChecks++;
                existing.status = 'failing';
              }
              existing.totalChecks++;
            }
          }
          
          const total = passing + failing;
          return {
            asset: {
              uuid: app.identifier || app.version_uuid || searchTerm,
              name: app.app_name || app.app_code || searchTerm,
              type: app.type || 'application',
            },
            score: total > 0 ? passing / total : 0,
            passing,
            failing,
            total,
            lastUpdated: new Date().toISOString(),
            controls: Array.from(controlMap.values()),
          };
        }
        
        // Check nested assets
        for (const asset of app.assets || []) {
          if (asset.name?.toLowerCase().includes(searchLower) ||
              asset.repository?.toLowerCase().includes(searchLower) ||
              asset.uuid?.toLowerCase() === searchLower) {
            
            console.log(`Found matching asset: ${asset.name}`);
            
            // Count attestations for this asset
            let passing = 0;
            let failing = 0;
            const controlMap = new Map<string, ControlStatus>();
            
            for (const attestation of asset.attestations || []) {
              const isPassing = attestation.status === 'pass' || attestation.result === 'pass';
              if (isPassing) passing++;
              else failing++;
              
              const controlKey = attestation.entity_id || attestation.uuid;
              if (!controlMap.has(controlKey)) {
                controlMap.set(controlKey, {
                  uuid: attestation.uuid,
                  name: controlKey,
                  description: `Control: ${controlKey}`,
                  status: isPassing ? 'passing' : 'failing',
                  severity: 'medium',
                  passingChecks: isPassing ? 1 : 0,
                  failingChecks: isPassing ? 0 : 1,
                  totalChecks: 1,
                });
              } else {
                const existing = controlMap.get(controlKey)!;
                if (isPassing) existing.passingChecks++;
                else {
                  existing.failingChecks++;
                  existing.status = 'failing';
                }
                existing.totalChecks++;
              }
            }
            
            const total = passing + failing;
            return {
              asset: {
                uuid: asset.uuid || searchTerm,
                name: asset.name || searchTerm,
                type: asset.type || 'repository',
              },
              score: total > 0 ? passing / total : 0,
              passing,
              failing,
              total,
              lastUpdated: new Date().toISOString(),
              controls: Array.from(controlMap.values()),
            };
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('Failed to search org compliance data:', error);
      return null;
    }
  }

  /**
   * Fetch all required controls for an asset from policy gates
   *
   * STRATEGY: 4-tier fallback approach because the API doesn't guarantee gate availability
   * 1. Direct asset gates: /assets/{uuid}/gates/policies/controls
   * 2. Child asset gates: /assets/children/{uuid}/gates/policies/controls (for applications)
   * 3. Lookup child assets from compliance data, then query their gates
   * 4. Fallback: Fetch all org gates and aggregate their controls
   *
   * WHY 4 STRATEGIES?
   * - Applications may have gates at the application level or child repository level
   * - API endpoints return different results for different asset types
   * - Some assets don't have gates directly attached but inherit from parent/siblings
   * - We need to exhaust all possibilities before concluding "no gates"
   *
   * Returns controls grouped by policy that are REQUIRED for this asset
   *
   * @param assetUuid - Asset UUID to query
   * @returns Map of control path/UUID → ControlStatus objects
   *
   * Public alias: getAssetRequiredControls
   */
  async getAssetRequiredControls(assetUuid: string): Promise<Map<string, ControlStatus>> {
    return this.getRequiredControlsForAsset(assetUuid);
  }

  private async getRequiredControlsForAsset(assetUuid: string): Promise<Map<string, ControlStatus>> {
    const requiredControls = new Map<string, ControlStatus>();

    // Response structure from API (controlsUnderPolicyGroupV001)
    interface GateResponse {
      name?: string;
      policyName?: string;
      policyEntityKey?: string;
      policyEntityId?: string;
      path?: string;
      entityId?: string;
      controls?: Array<{
        uuid?: string;
        name?: string;
        displayKey?: string;
        path?: string;
        description?: string;
        severity?: string;
        detail?: { description?: string };
      }>;
    }
    
    // Helper function to parse gate responses and extract control requirements
    // Used by all 4 strategies to normalize API responses into our control map
    const processGatesResponse = (gatesData: GateResponse[], source: string) => {
      if (!Array.isArray(gatesData) || gatesData.length === 0) {
        console.log(`No gates from ${source}`);
        return;
      }

      console.log(`Found ${gatesData.length} policy gates from ${source}`);

      for (const gate of gatesData) {
        const policyName = gate.policyName || gate.name || gate.policyEntityKey || 'Policy';
        
        for (const control of gate.controls || []) {
          const controlKey = control.path || control.uuid || control.name || control.displayKey;
          if (!controlKey) continue;
          
          if (!requiredControls.has(controlKey)) {
            requiredControls.set(controlKey, {
              uuid: control.uuid || '',
              name: control.displayKey || control.name || control.path || controlKey,
              description: control.description || control.detail?.description || `Path: ${control.path || 'N/A'}`,
              status: 'not_found', // Will be updated if attestation exists
              severity: (control.severity as any) || 'medium',
              passingChecks: 0,
              failingChecks: 0,
              totalChecks: 0,
              required: true,
              policyName,
              controlPath: control.path,
            });
          }
        }
      }
    };
    
    try {
      console.log(`Fetching required controls for asset: ${assetUuid}`);
      
      // Strategy 1: Direct asset gates
      try {
        const gatesData = await this.fetch<GateResponse[]>(
          `/assets/${encodeURIComponent(assetUuid)}/gates/policies/controls`
        );
        processGatesResponse(gatesData, 'direct asset');
      } catch (e) {
        console.log(`Direct asset gates failed: ${e}`);
      }
      
      // Strategy 2: Child asset gates (for applications with child repositories)
      // Applications may not have gates themselves, but their child repos do
      if (requiredControls.size === 0) {
        try {
          const childGatesData = await this.fetch<GateResponse[]>(
            `/assets/children/${encodeURIComponent(assetUuid)}/gates/policies/controls`
          );
          processGatesResponse(childGatesData, 'child assets');
        } catch (e) {
          console.log(`Child asset gates failed: ${e}`);
        }
      }

      // Strategy 3: Lookup child assets from compliance data, then query their gates individually
      // This handles cases where the /children endpoint doesn't work but we can find children manually
      if (requiredControls.size === 0) {
        try {
          const complianceData = await this.fetch<ApplicationComplianceResponse[]>(`/evidence/assets/compliance`);
          const applications = Array.isArray(complianceData) ? complianceData : [];
          
          for (const app of applications) {
            if (app.identifier === assetUuid || app.version_uuid === assetUuid) {
              // Try each child asset
              for (const asset of app.assets || []) {
                if (asset.uuid) {
                  try {
                    const assetGates = await this.fetch<GateResponse[]>(
                      `/assets/${encodeURIComponent(asset.uuid)}/gates/policies/controls`
                    );
                    processGatesResponse(assetGates, `child asset ${asset.name || asset.uuid}`);
                  } catch (e) {
                    console.log(`Gates for child asset ${asset.uuid} failed: ${e}`);
                  }
                }
              }
              break;
            }
          }
        } catch (e) {
          console.log(`Compliance data lookup failed: ${e}`);
        }
      }

      // Strategy 4: Last resort - fetch all org gates and aggregate their controls
      // This gives a complete picture of what controls COULD be required
      // We limit to 5 gates to avoid rate limiting and excessive API calls
      if (requiredControls.size === 0) {
        try {
          console.log('Trying fallback: fetching all gates and their controls');
          const gates = await this.listGates();

          // Get controls from first 5 gates (arbitrary limit to avoid rate limiting)
          for (const gate of gates.slice(0, 5)) {
            const gateControls = await this.getGateRequiredControls(gate.entityKey);
            for (const [key, control] of gateControls) {
              if (!requiredControls.has(key)) {
                control.policyName = `Gate: ${gate.name}`;
                requiredControls.set(key, control);
              }
            }
          }
          
          console.log(`Found ${requiredControls.size} controls from ${gates.length} gates`);
        } catch (e) {
          console.log(`Gates fallback failed: ${e}`);
        }
      }
      
      console.log(`Total required controls found: ${requiredControls.size}`);
      return requiredControls;
    } catch (error) {
      console.warn(`Failed to fetch required controls for asset ${assetUuid}:`, error);
      return requiredControls;
    }
  }

  /**
   * Look up an asset by identifier/name to get its UUID
   * Uses /assets endpoint with identifier query parameter
   */
  private async lookupAssetUuid(identifier: string): Promise<string | null> {
    try {
      // Try looking up by identifier
      const response = await this.fetch<any>(`/assets?identifier=${encodeURIComponent(identifier)}`);
      
      // Response could be array or object with assets
      const assets = Array.isArray(response) ? response : (response.assets || response.items || []);
      
      if (assets.length > 0) {
        // Return the first matching asset's UUID
        return assets[0].uuid || assets[0].id || null;
      }
      
      // Try looking up by name in the compliance data
      const complianceData = await this.fetch<ApplicationComplianceResponse[]>(`/evidence/assets/compliance`);
      const applications = Array.isArray(complianceData) ? complianceData : [];
      
      for (const app of applications) {
        if (app.app_name === identifier || app.app_code === identifier || app.identifier === identifier) {
          return app.identifier; // Use the identifier as the asset reference
        }
        // Check nested assets
        for (const asset of app.assets || []) {
          if (asset.name === identifier || asset.uuid === identifier) {
            return asset.uuid;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.warn(`Asset lookup failed for ${identifier}:`, error);
      return null;
    }
  }

  /**
   * Get compliance status for a specific asset
   * Combines:
   * 1. Required controls from /assets/{uuid}/gates/policies/controls (what's required by policy)
   * 2. Attestations from /evidence/assets/:asset/attestations/snapshot (what evidence exists)
   * 
   * This gives a complete picture: required controls with/without evidence
   */
  async getAssetCompliance(
    assetIdentifier: string,
    assetType?: string,
    branch: string = 'default',
    commit?: string
  ): Promise<ComplianceStatus> {
    // Use the foundational resolver to normalize asset, branch, and commit
    const context = await this.resolveAssetContext(assetIdentifier, { 
      branch: branch !== 'default' ? branch : undefined, 
      commit 
    });
    
    // Use resolved commit for cache key (ensures short SHA and full SHA hit same cache)
    const effectiveCommit = context.resolvedCommit || commit || 'latest';
    // Add timestamp to cache key to bust cache during development/testing
    const cacheKey = `compliance:${assetIdentifier}:${context.resolvedBranch || branch}:${effectiveCommit}:${this.session.tenantId}:v5`;
    
    // Try cache first
    const cached = await this.getFromCache<ComplianceStatus>(cacheKey);
    if (cached) {
      return cached;
    }

    // Use resolved values from context
    const assetUuid = context.assetUuid || assetIdentifier;
    const assetName = context.assetName || assetIdentifier;
    const resolvedCommit = context.resolvedCommit;
    
    console.log(`getAssetCompliance: Using resolved asset=${assetUuid}, commit=${resolvedCommit || 'none'}, branch=${context.resolvedBranch || 'default'}`);

    // Step 1: Fetch REQUIRED controls from policy gates
    // This tells us what controls SHOULD have evidence
    const requiredControls = await this.getRequiredControlsForAsset(assetUuid);
    console.log(`Found ${requiredControls.size} required controls from policy gates`);

    // Step 2: Fetch attestations (evidence that exists)
    // If a commit is resolved, use /notes endpoint to get UUIDs, then fetch full details
    // Otherwise fall back to /attestations/snapshot endpoint
    let attestationData: AssetAttestationSnapshotResponse | null = null;
    let fetchedAssetName = assetName;
    try {
      if (resolvedCommit) {
        // Use /notes?commit=<sha>&type=attestation to get attestation UUIDs
        // Then fetch full details for each to get control paths (Fior spec)
        console.log(`Fetching attestations for resolved commit via /notes: ${resolvedCommit}`);
        const queryParams = new URLSearchParams();
        queryParams.set('commit', resolvedCommit);
        queryParams.set('type', 'attestation');
        const notesUrl = `/notes?${queryParams.toString()}`;
        
        const notesData = await this.fetch<any>(notesUrl);
        const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
        console.log(`Found ${notes.length} attestation notes from /notes endpoint`);
        
        // Fetch full details for each attestation to get control paths
        // The /notes list endpoint returns minimal info, but /evidence/notes/{uuid} returns full Fior spec
        const attestations: AttestationResult[] = [];
        const batchSize = 10;
        
        for (let i = 0; i < notes.length; i += batchSize) {
          const batch = notes.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (note: any) => {
              try {
                // Fetch full attestation details
                const details = await this.getAttestationDetails(note.uuid);
                if (!details) return null;
                
                // Extract control info from full Fior spec format
                // producer.entity contains the control info in v3+
                const controlUuid = details.producer?.entity?.uuid || details.control?.uuid || note.control?.uuid;
                const controlPath = details.producer?.entity?.path || details.metadata?.path || details.control?.path || note.tag;
                const controlName = details.producer?.entity?.name || details.metadata?.entity?.displayKey || details.control?.name;
                
                console.log(`Attestation ${note.uuid}: path=${controlPath}, name=${controlName}, result=${details.result || note.result}`);
                
                return {
                  asset: note.asset || assetUuid,
                  uuid: note.uuid,
                  result: details.result || note.result || 'unknown',
                  type: note.type || 'attestation',
                  apiVersion: details.apiVersion || 'v1',
                  annotated: note.annotated || false,
                  control: {
                    uuid: controlUuid,
                    path: controlPath,
                    name: controlName,
                    version: details.producer?.entity?.version?.semantic,
                  },
                  policy: details.policy || note.policy,
                  sequence: details.sequence || note.sequence || [],
                };
              } catch (e) {
                console.warn(`Failed to fetch attestation details for ${note.uuid}:`, e);
                // Fall back to basic info from the note
                return {
                  asset: note.asset || assetUuid,
                  uuid: note.uuid,
                  result: note.result || 'unknown',
                  type: note.type || 'attestation',
                  apiVersion: 'v1',
                  annotated: note.annotated || false,
                  control: {
                    uuid: note.control?.uuid,
                    path: note.tag || note.control?.path,
                    name: note.control?.name,
                  },
                  policy: note.policy,
                  sequence: note.sequence || [],
                };
              }
            })
          );
          
          for (const result of batchResults) {
            if (result) {
              attestations.push(result);
            }
          }
        }
        
        console.log(`Successfully fetched full details for ${attestations.length} attestations`);
        
        attestationData = {
          asset: assetUuid,
          commit: resolvedCommit,
          count: attestations.length,
          assetName: assetName,
          assetType: 'repository',
          instance: '',
          attestations,
        };
        fetchedAssetName = assetName;
      } else {
        // Fall back to snapshot endpoint for latest/default queries
        const snapshotUrl = `/evidence/assets/${encodeURIComponent(assetUuid)}/attestations/snapshot`;
        console.log(`Fetching attestations from snapshot endpoint: ${snapshotUrl}`);
        attestationData = await this.fetch<AssetAttestationSnapshotResponse>(snapshotUrl);
        fetchedAssetName = attestationData.assetName || assetIdentifier;
      }
      console.log(`Found ${attestationData.attestations?.length || 0} attestations total`);
    } catch (error) {
      console.warn(`Failed to fetch attestations for ${assetUuid}:`, error);
      // Continue - we might still have required controls to show
    }

    // Step 3: Merge required controls with attestation data
    // Start with required controls (status: not_found by default)
    const controlMap = new Map<string, ControlStatus>(requiredControls);
    let passing = 0;
    let failing = 0;
    let notFoundRequired = 0;

    // Process attestations and update control statuses
    for (const attestation of attestationData?.attestations || []) {
      const controlPath = attestation.control?.path;
      const controlName = attestation.control?.name;
      const controlUuid = attestation.control?.uuid;
      const controlKey = controlPath || controlName || attestation.uuid;
      const isPassing = attestation.result === 'pass';
      
      console.log(`Processing attestation: path=${controlPath}, name=${controlName}, uuid=${controlUuid}, result=${attestation.result}`);
      
      if (isPassing) {
        passing++;
      } else {
        failing++;
      }

      // Check if this control exists in required controls (try multiple keys)
      // Try: controlKey (path or name), then path explicitly, then name, then UUID
      let existingControl = controlMap.get(controlKey);
      if (!existingControl && controlPath) {
        existingControl = controlMap.get(controlPath);
      }
      if (!existingControl && controlName) {
        existingControl = controlMap.get(controlName);
      }
      if (!existingControl && controlUuid) {
        // Try to find by UUID - required controls might be keyed by UUID
        existingControl = controlMap.get(controlUuid);
      }
      
      // Also try to find by iterating through required controls and matching UUID
      if (!existingControl && controlUuid) {
        for (const [key, ctrl] of controlMap) {
          if (ctrl.uuid === controlUuid || ctrl.controlPath === controlPath) {
            existingControl = ctrl;
            console.log(`Found match by UUID/path iteration: ${key}`);
            break;
          }
        }
      }

      if (existingControl) {
        // Update existing required control with attestation data
        console.log(`Matched attestation to required control: ${existingControl.name} (${existingControl.controlPath})`);
        existingControl.status = isPassing ? 'passing' : 'failing';
        existingControl.uuid = controlUuid || existingControl.uuid;
        if (isPassing) {
          existingControl.passingChecks++;
        } else {
          existingControl.failingChecks++;
        }
        existingControl.totalChecks++;
      } else {
        // This attestation is for a control not in the required list
        // (optional control that has evidence anyway)
        console.log(`No match found - adding as optional control: ${controlKey}`);
        controlMap.set(controlKey, {
          uuid: controlUuid || attestation.uuid,
          name: controlName || controlKey,
          description: controlPath ? `Path: ${controlPath}` : `Control: ${controlKey}`,
          status: isPassing ? 'passing' : 'failing',
          severity: 'medium',
          passingChecks: isPassing ? 1 : 0,
          failingChecks: isPassing ? 0 : 1,
          totalChecks: 1,
          required: false, // Not required by policy
          controlPath: controlPath,
        });
      }
    }

    // Count required controls that are still not_found
    for (const control of controlMap.values()) {
      if (control.required && control.status === 'not_found') {
        notFoundRequired++;
      }
    }

    // Calculate score based on required controls
    // Not found required controls count as failing for compliance purposes
    const totalRequired = requiredControls.size;
    const passingRequired = Array.from(controlMap.values())
      .filter(c => c.required && c.status === 'passing')
      .length;
    
    // Overall score: passing required / total required
    // If no required controls, use attestation pass rate
    let score: number;
    if (totalRequired > 0) {
      score = passingRequired / totalRequired;
    } else {
      const total = passing + failing;
      score = total > 0 ? passing / total : 0;
    }

    // Transform to ComplianceStatus
    const result: ComplianceStatus = {
      asset: {
        uuid: attestationData?.asset || assetUuid,
        name: fetchedAssetName,
        type: attestationData?.assetType || assetType || 'unknown',
        branch: context.resolvedBranch || branch,
        commit: resolvedCommit || undefined,
      },
      score,
      passing,
      failing,
      total: passing + failing,
      lastUpdated: new Date().toISOString(),
      controls: Array.from(controlMap.values()),
      // Add summary fields for required controls
      requiredControls: totalRequired,
      requiredPassing: passingRequired,
      requiredNotFound: notFoundRequired,
      // Add resolution debug info
      resolution: {
        originalCommit: context.originalCommit,
        resolvedCommit: context.resolvedCommit,
        originalBranch: context.originalBranch,
        resolvedBranch: context.resolvedBranch,
        defaultBranch: context.defaultBranch,
      },
    } as ComplianceStatus & { requiredControls?: number; requiredPassing?: number; requiredNotFound?: number; resolution?: any };

    // Enrich control names if we have controls
    if (result.controls.length > 0) {
      await this.enrichControlNames(result.controls);
    }

    // Only cache if we have data (either attestations or required controls)
    if (result.controls.length > 0) {
      await this.setCache(cacheKey, result, 300);
    }

    return result;
  }

  /**
   * List available assets from the compliance data
   * Returns a sample of asset identifiers to help with lookups
   */
  async listAvailableAssets(searchTerm?: string): Promise<{ assets: Array<{ identifier: string; name: string; type: string; uuid?: string }> }> {
    try {
      // Get compliance data which includes all assets
      const complianceData = await this.fetch<ApplicationComplianceResponse[]>(`/evidence/assets/compliance`);
      const applications = Array.isArray(complianceData) ? complianceData : [];
      
      const assets: Array<{ identifier: string; name: string; type: string; uuid?: string }> = [];
      
      for (const app of applications) {
        // Add the application itself
        const appEntry = {
          identifier: app.identifier || app.app_code,
          name: app.app_name || app.app_code,
          type: app.type || 'application',
          uuid: app.version_uuid,
        };
        
        // Filter by search term if provided
        if (!searchTerm || 
            appEntry.identifier?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            appEntry.name?.toLowerCase().includes(searchTerm.toLowerCase())) {
          assets.push(appEntry);
        }
        
        // Add nested assets
        for (const asset of app.assets || []) {
          const assetEntry = {
            identifier: asset.repository || asset.name,
            name: asset.name,
            type: asset.type || 'repository',
            uuid: asset.uuid,
          };
          
          if (!searchTerm ||
              assetEntry.identifier?.toLowerCase().includes(searchTerm.toLowerCase()) ||
              assetEntry.name?.toLowerCase().includes(searchTerm.toLowerCase())) {
            assets.push(assetEntry);
          }
        }
      }
      
      return { assets };
    } catch (error) {
      console.error('Failed to list assets:', error);
      return { assets: [] };
    }
  }

  /**
   * List releases for an application
   * Uses /assets?type=release endpoint
   * 
   * @param options.applicationName - Filter releases by parent application name/code
   * @param options.applicationUuid - Filter releases by parent application UUID
   * @param options.status - Filter by release status ('pending', 'released', or 'all')
   * @param options.limit - Maximum number of results
   */
  async listReleases(options: {
    applicationName?: string;
    applicationUuid?: string;
    status?: 'pending' | 'released' | 'all';
    limit?: number;
  } = {}): Promise<{
    success: boolean;
    releases: ReleaseAsset[];
    count: number;
    filtered: {
      byApplication?: string;
      byStatus?: string;
      resolvedApp?: string;
      resolvedUuid?: string;
    };
    error?: string;
  }> {
    try {
      console.log(`[listReleases] Fetching releases with options:`, options);
      
      const filtered: { byApplication?: string; byStatus?: string; resolvedApp?: string; resolvedUuid?: string; childUuidsUsed?: string[] } = {};
      let resolvedAppUuid: string | undefined;
      let resolvedAppName: string | undefined;
      let childAssetUuids: string[] = [];
      
      // Helper to check if a string looks like a valid UUID
      const isValidUuid = (str: string | undefined): boolean => {
        if (!str) return false;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
      };
      
      // If application specified, resolve it first to get the UUID
      if (options.applicationName || options.applicationUuid) {
        if (options.applicationName) {
          const resolved = await this.resolveApplication(options.applicationName);
          if (resolved.found) {
            resolvedAppName = resolved.name;
            resolvedAppUuid = resolved.uuid;
            
            // Get child asset UUIDs for includesChild query
            // The includesChild parameter expects valid UUIDs
            if (resolved.assets && resolved.assets.length > 0) {
              childAssetUuids = resolved.assets
                .map(a => a.uuid)
                .filter(uuid => isValidUuid(uuid));
              console.log(`[listReleases] Found ${childAssetUuids.length} valid child asset UUIDs for includesChild query`);
            }
            
            console.log(`[listReleases] Resolved "${options.applicationName}" -> "${resolvedAppName}" (appId: ${resolvedAppUuid}, children: ${childAssetUuids.length})`);
          } else {
            console.log(`[listReleases] Could not resolve "${options.applicationName}"`);
          }
        } else if (options.applicationUuid) {
          resolvedAppUuid = options.applicationUuid;
        }
        
        filtered.byApplication = options.applicationName || options.applicationUuid;
        filtered.resolvedApp = resolvedAppName;
        filtered.resolvedUuid = resolvedAppUuid;
      }
      
      // Build the API endpoint
      // Use includesChild parameter to find releases that include the app's repos
      // Note: includesChild requires a valid UUID, and app identifiers may not be valid UUIDs
      const queryParams = new URLSearchParams();
      queryParams.set('assetType', 'release');
      
      // Determine which UUID(s) to use for includesChild
      // If app UUID is valid, use it. Otherwise, query for EACH child asset and combine results
      let uuidsToQuery: string[] = [];
      
      if (isValidUuid(resolvedAppUuid)) {
        uuidsToQuery = [resolvedAppUuid];
        console.log(`[listReleases] Using app UUID for includesChild: ${resolvedAppUuid}`);
      } else if (childAssetUuids.length > 0) {
        // Query for ALL child asset UUIDs to find any releases containing them
        uuidsToQuery = childAssetUuids;
        filtered.childUuidsUsed = childAssetUuids;
        console.log(`[listReleases] App UUID not valid, will query ${childAssetUuids.length} child asset UUIDs`);
      }
      
      // Query for releases - if we have multiple UUIDs, query each and combine
      let allReleases: any[] = [];
      const seenUuids = new Set<string>();
      
      if (uuidsToQuery.length === 0) {
        // No UUIDs to query - get all releases
        const endpoint = `/assets?assetType=release${options.limit ? `&limit=${options.limit}` : ''}`;
        console.log(`[listReleases] No app filter, calling: ${endpoint}`);
        const response = await this.fetch<any[]>(endpoint);
        allReleases = Array.isArray(response) ? response : [];
      } else if (uuidsToQuery.length === 1) {
        // Single UUID - simple query
        const endpoint = `/assets?assetType=release&includesChild=${uuidsToQuery[0]}${options.limit ? `&limit=${options.limit}` : ''}`;
        console.log(`[listReleases] Calling endpoint: ${endpoint}`);
        const response = await this.fetch<any[]>(endpoint);
        allReleases = Array.isArray(response) ? response : [];
      } else {
        // Multiple UUIDs - query each and combine (dedupe by UUID)
        console.log(`[listReleases] Querying ${uuidsToQuery.length} child assets for releases...`);
        for (const uuid of uuidsToQuery) {
          try {
            const endpoint = `/assets?assetType=release&includesChild=${uuid}`;
            console.log(`[listReleases] Querying child ${uuid}...`);
            const response = await this.fetch<any[]>(endpoint);
            if (Array.isArray(response)) {
              for (const release of response) {
                if (release.uuid && !seenUuids.has(release.uuid)) {
                  seenUuids.add(release.uuid);
                  allReleases.push(release);
                }
              }
            }
          } catch (err) {
            console.log(`[listReleases] Error querying child ${uuid}: ${err}`);
          }
        }
        console.log(`[listReleases] Combined ${allReleases.length} unique releases from ${uuidsToQuery.length} child queries`);
      }
      
      const response = allReleases;
      
      if (!Array.isArray(response)) {
        console.log(`[listReleases] Unexpected response type: ${typeof response}`);
        return {
          success: false,
          releases: [],
          count: 0,
          filtered,
          error: 'Unexpected response format from /assets',
        };
      }
      
      console.log(`[listReleases] Got ${response.length} assets from API`);
      
      // Log the types we received to understand what's coming back
      const typeBreakdown = response.reduce((acc: Record<string, number>, item: any) => {
        const t = item.type || 'unknown';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {});
      console.log(`[listReleases] Asset types in response: ${JSON.stringify(typeBreakdown)}`);
      
      // Filter for actual releases (type === 'release')
      let filteredReleases = response.filter((r: any) => r.type === 'release');
      
      console.log(`[listReleases] Found ${filteredReleases.length} releases after filtering for type=release`);
      
      // Log sample release structure for debugging
      if (filteredReleases.length > 0) {
        console.log(`[listReleases] Sample release keys: ${Object.keys(filteredReleases[0]).join(', ')}`);
        console.log(`[listReleases] Sample release: ${JSON.stringify(filteredReleases[0], null, 2).substring(0, 500)}...`);
      }
      
      // Filter by status if provided (check both top-level status and asset.release.status property)
      if (options.status && options.status !== 'all') {
        const statusToMatch = options.status.toLowerCase();
        filteredReleases = filteredReleases.filter(release => {
          // Check top-level status
          if (release.status?.toLowerCase() === statusToMatch) return true;
          
          // Check properties for asset.release.status
          const releaseStatusProp = release.properties?.find((p: any) => p.key === 'asset.release.status');
          if (releaseStatusProp?.value?.toLowerCase() === statusToMatch) return true;
          
          return false;
        });
        filtered.byStatus = options.status;
        console.log(`[listReleases] After status filter: ${filteredReleases.length} releases`);
      }
      
      // Map to consistent structure
      const releases: ReleaseAsset[] = filteredReleases.map(r => {
        // Get release status from properties (asset.release.status) since it differs from asset status
        const releaseStatusProp = r.properties?.find((p: any) => p.key === 'asset.release.status');
        const releaseStatus = releaseStatusProp?.value?.toLowerCase() || r.status || 'unknown';
        
        return {
          uuid: r.uuid,
          name: r.name,
          type: 'release',
          status: releaseStatus, // 'pending' or 'released' from property
          parent: r.parent,
          parentName: r.lineage?.find((l: any) => l.type === 'application')?.name || r.subtitle,
          key: r.key,
          createdAt: r.createdAt,
          modifiedAt: r.modifiedAt,
          properties: r.properties,
          lineage: r.lineage,
          targetEnvironment: r.properties?.find((p: any) => p.key === 'target_environment')?.value,
          targetGate: r.properties?.find((p: any) => p.key === 'target_gate')?.value,
          // Include additional useful fields
          subtitle: r.subtitle,
          version: r.properties?.find((p: any) => p.key === 'asset.release.version')?.value,
          releaseId: r.properties?.find((p: any) => p.key === 'asset.release.id')?.value,
        };
      });
      
      return {
        success: true,
        releases,
        count: releases.length,
        filtered,
      };
    } catch (error) {
      console.error('[listReleases] Failed:', error);
      return {
        success: false,
        releases: [],
        count: 0,
        filtered: {},
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * List policy exceptions - EXPLORATION
   * Uses /console/policies/exceptions endpoint
   * Returns raw response for structure discovery
   */
  async listPolicyExceptions(options: {
    limit?: number;
  } = {}): Promise<any> {
    const { limit = 50 } = options;
    
    try {
      console.log(`[listPolicyExceptions] Fetching policy exceptions...`);
      
      // Try different endpoint patterns
      const endpoints = [
        `/console/policies/exceptions`,
        `/policies/exceptions`,
        `/console/exceptions`,
        `/exceptions`,
      ];
      
      for (const endpoint of endpoints) {
        try {
          console.log(`[listPolicyExceptions] Trying endpoint: ${endpoint}`);
          const data = await this.fetch<any>(`${endpoint}?limit=${limit}`);
          console.log(`[listPolicyExceptions] SUCCESS with ${endpoint}`);
          console.log(`[listPolicyExceptions] Response type: ${typeof data}`);
          console.log(`[listPolicyExceptions] Is array: ${Array.isArray(data)}`);
          
          // Log first item structure if array
          if (Array.isArray(data) && data.length > 0) {
            console.log(`[listPolicyExceptions] First item keys: ${Object.keys(data[0]).join(', ')}`);
            console.log(`[listPolicyExceptions] Sample item: ${JSON.stringify(data[0], null, 2)}`);
          } else if (data && typeof data === 'object') {
            console.log(`[listPolicyExceptions] Response keys: ${Object.keys(data).join(', ')}`);
          }
          
          return {
            success: true,
            endpoint,
            data,
            count: Array.isArray(data) ? data.length : (data?.exceptions?.length || data?.data?.length || 'unknown'),
          };
        } catch (e: any) {
          console.log(`[listPolicyExceptions] ${endpoint} failed: ${e.message}`);
          continue;
        }
      }
      
      return {
        success: false,
        error: 'No working endpoint found',
        triedEndpoints: endpoints,
      };
    } catch (error) {
      console.error('[listPolicyExceptions] Failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Explore asset search capabilities - for deep linking feature
   * Tests various search parameters to find how we can locate assets by digest/artifact
   */
  async exploreAssetSearch(searchParams: {
    digest?: string;
    artifact?: string;
    repository?: string;
    image?: string;
  } = {}): Promise<any> {
    const results: any = {
      endpoints: [],
      searchParams,
    };
    
    // Test various endpoints to see what search capabilities exist
    const endpointsToTry = [
      { path: '/assets', params: searchParams },
      { path: '/evidence/assets', params: searchParams },
      { path: '/assets/search', params: searchParams },
      { path: '/notes', params: { kind: 'attestation', limit: 5, ...searchParams } },
    ];
    
    for (const { path, params } of endpointsToTry) {
      try {
        const queryString = Object.entries(params)
          .filter(([_, v]) => v)
          .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
          .join('&');
        
        const url = queryString ? `${path}?${queryString}` : path;
        console.log(`[exploreAssetSearch] Trying ${url}...`);
        
        const response = await this.fetch<any>(url);
        
        results.endpoints.push({
          success: true,
          url,
          responseType: typeof response,
          isArray: Array.isArray(response),
          count: Array.isArray(response) ? response.length : (response?.items?.length || response?.assets?.length || 'N/A'),
          sampleKeys: response && typeof response === 'object' 
            ? (Array.isArray(response) && response[0] ? Object.keys(response[0]) : Object.keys(response))
            : [],
          sample: Array.isArray(response) ? response[0] : response,
        });
      } catch (err: any) {
        results.endpoints.push({
          success: false,
          url: `${path}?...`,
          error: err.message,
        });
      }
    }
    
    return results;
  }

  /**
   * Get a specific policy exception by ID - check for more detail
   */
  async getPolicyException(entityId: string): Promise<any> {
    try {
      console.log(`[getPolicyException] Fetching exception ${entityId}...`);
      
      // Try different endpoint patterns
      const endpoints = [
        `/console/exceptions/${entityId}`,
        `/policies/exceptions/${entityId}`,
        `/console/policies/exceptions/${entityId}`,
      ];
      
      for (const endpoint of endpoints) {
        try {
          console.log(`[getPolicyException] Trying ${endpoint}...`);
          const response = await this.fetch<any>(endpoint);
          return {
            success: true,
            endpoint,
            data: response,
          };
        } catch (err: any) {
          console.log(`[getPolicyException] Failed ${endpoint}: ${err.message}`);
          continue;
        }
      }
      
      return {
        success: false,
        message: 'No working endpoint found for single exception',
      };
    } catch (error: any) {
      console.error(`[getPolicyException] Error:`, error);
      throw error;
    }
  }

  /**
   * Explore exception audit/history - check for requester info
   */
  async getExceptionAudit(entityId: string): Promise<any> {
    try {
      console.log(`[getExceptionAudit] Checking audit trail for ${entityId}...`);
      
      // Try different audit/history patterns
      const endpoints = [
        `/console/exceptions/${entityId}/audit`,
        `/console/exceptions/${entityId}/history`,
        `/console/exceptions/${entityId}/versions`,
        `/audit/exceptions/${entityId}`,
      ];
      
      for (const endpoint of endpoints) {
        try {
          console.log(`[getExceptionAudit] Trying ${endpoint}...`);
          const response = await this.fetch<any>(endpoint);
          return {
            success: true,
            endpoint,
            data: response,
          };
        } catch (err: any) {
          console.log(`[getExceptionAudit] Failed ${endpoint}: ${err.message}`);
          continue;
        }
      }
      
      return {
        success: false,
        message: 'No audit/history endpoint found',
      };
    } catch (error: any) {
      console.error(`[getExceptionAudit] Error:`, error);
      throw error;
    }
  }

  /**
   * List all gates configured in the organization
   * Uses /console/gates endpoint
   */
  async listGates(): Promise<Array<{ entityKey: string; name: string; displayKey?: string; uuid?: string }>> {
    try {
      const gatesData = await this.fetch<any[]>(`/console/gates`);
      
      if (!Array.isArray(gatesData)) {
        return [];
      }
      
      return gatesData.map(gate => ({
        entityKey: gate.entityKey || gate.entityId || gate.path || gate.name,
        name: gate.displayKey || gate.name || gate.entityKey,
        displayKey: gate.displayKey,
        uuid: gate.uuid,
      }));
    } catch (error) {
      console.warn('Failed to list gates:', error);
      return [];
    }
  }

  /**
   * Get required controls for a specific gate (e.g., "staging", "prod")
   * Uses /console/gates/:entity_key/policies/controls endpoint
   * This is useful for understanding "what's blocking deployment to [gate]"
   */
  async getGateRequiredControls(gateEntityKey: string): Promise<Map<string, ControlStatus>> {
    const requiredControls = new Map<string, ControlStatus>();
    
    try {
      console.log(`Fetching required controls for gate: ${gateEntityKey}`);
      const gateData = await this.fetch<any[]>(
        `/console/gates/${encodeURIComponent(gateEntityKey)}/policies/controls`
      );
      
      if (!Array.isArray(gateData)) {
        console.log('Gate controls response is not an array');
        return requiredControls;
      }
      
      console.log(`Found ${gateData.length} policy groups for gate ${gateEntityKey}`);
      
      for (const policyGroup of gateData) {
        const policyName = policyGroup.policyName || policyGroup.name || policyGroup.policyEntityKey || 'Policy';
        
        for (const control of policyGroup.controls || []) {
          const controlKey = control.path || control.uuid || control.name || control.displayKey;
          if (!controlKey) continue;
          
          if (!requiredControls.has(controlKey)) {
            requiredControls.set(controlKey, {
              uuid: control.uuid || '',
              name: control.displayKey || control.name || control.path || controlKey,
              description: control.description || control.detail?.description || `Path: ${control.path || 'N/A'}`,
              status: 'not_found',
              severity: (control.severity as any) || 'medium',
              passingChecks: 0,
              failingChecks: 0,
              totalChecks: 0,
              required: true,
              policyName,
              controlPath: control.path,
            });
          }
        }
      }
      
      console.log(`Found ${requiredControls.size} required controls for gate ${gateEntityKey}`);
      return requiredControls;
    } catch (error) {
      console.warn(`Failed to fetch controls for gate ${gateEntityKey}:`, error);
      return requiredControls;
    }
  }

  /**
   * List all controls applicable to the tenant
   * Uses /console/controls endpoint
   */
  async listControls(
    framework?: string,
    severity?: string
  ): Promise<Control[]> {
    const cacheKey = `controls:${framework || 'all'}:${severity || 'all'}:${this.session.tenantId}`;
    
    const cached = await this.getFromCache<Control[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const params = new URLSearchParams();
    if (framework) {
      params.append('framework', framework);
    }
    if (severity) {
      params.append('severity', severity);
    }

    // Use the correct endpoint: /console/controls
    const queryString = params.toString();
    const data = await this.fetch<any[]>(
      `/console/controls${queryString ? '?' + queryString : ''}`
    );

    // Transform API response to our Control type
    const controls: Control[] = (data || []).map(control => ({
      uuid: control.uuid || control.id || '',
      name: control.displayKey || control.name || control.path || '',
      description: control.description || control.detail?.description || '',
      category: control.category || control.type || '',
      severity: control.severity || 'medium',
      framework: control.framework || '',
      requirements: control.requirements || [],
    }));

    // Cache for 15 minutes (controls don't change often)
    await this.setCache(cacheKey, controls, 900);

    return controls;
  }

  /**
   * Get detailed attestation/note information including threshold values
   * Uses /evidence/notes/:uuid endpoint
   */
  async getAttestationDetails(attestationUuid: string): Promise<any> {
    try {
      const data = await this.fetch<any>(`/evidence/notes/${encodeURIComponent(attestationUuid)}`);
    return data;
    } catch (error) {
      console.warn(`Failed to fetch attestation details for ${attestationUuid}:`, error);
      return null;
    }
  }

  /**
   * Get attestations by control path across the organization
   * Used to answer: "Given this control ID/path, show me its latest evidence and pass/fail status"
   */
  async getAttestationsByControlPath(controlPath: string, limit: number = 100): Promise<any[]> {
    try {
      console.log(`Fetching org-wide attestations for control path: ${controlPath}`);
      
      // Query /notes with path filter
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'attestation');
      queryParams.set('path', controlPath);
      queryParams.set('limit', String(limit));
      
      const url = `/notes?${queryParams.toString()}`;
      const notesData = await this.fetch<any>(url);
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      
      console.log(`Found ${notes.length} attestations for control path: ${controlPath}`);
      
      // Enrich with full details for top N
      const enrichedNotes: any[] = [];
      const maxEnrich = Math.min(notes.length, 20); // Limit enrichment to avoid too many API calls
      
      for (let i = 0; i < maxEnrich; i++) {
        const note = notes[i];
        try {
          const details = await this.getAttestationDetails(note.uuid);
          if (details) {
            enrichedNotes.push({
              uuid: note.uuid,
              result: details.result || note.result,
              timestamp: details.timestamp || note.timestamp,
              asset: {
                uuid: details.asset?.uuid || note.asset,
                name: details.asset?.name || details.asset?.repository,
                repository: details.asset?.repository,
              },
              assetName: details.asset?.name || details.asset?.repository,
              assetUuid: details.asset?.uuid || note.asset,
              control: {
                path: details.producer?.entity?.path || details.control?.path || controlPath,
                name: details.producer?.entity?.name || details.control?.name,
              },
              evaluationSummary: details.policy?.evaluation?.logs?.[0] || details.evaluationSummary,
              detail: details.detail,
            });
          }
        } catch (e) {
          // Fall back to basic note info
          enrichedNotes.push({
            uuid: note.uuid,
            result: note.result,
            timestamp: note.timestamp,
            assetUuid: note.asset,
            control: { path: controlPath },
          });
        }
      }
      
      // Add remaining notes without enrichment
      for (let i = maxEnrich; i < notes.length; i++) {
        const note = notes[i];
        enrichedNotes.push({
          uuid: note.uuid,
          result: note.result,
          timestamp: note.timestamp,
          assetUuid: note.asset,
          control: { path: controlPath },
        });
      }
      
      // Sort by timestamp descending (most recent first)
      enrichedNotes.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
      
      return enrichedNotes;
    } catch (error) {
      console.warn(`Failed to fetch attestations for control path ${controlPath}:`, error);
      return [];
    }
  }

  /**
   * Get attestations for a specific asset, optionally filtered by control path and commit
   * 
   * PRIMARY STRATEGY: Use GET /notes endpoint with query parameters:
   * - repositoryId: UUID of the repository asset
   * - commit: specific commit SHA
   * - type: "attestation" to filter to attestations only
   * - path: control path for filtering
   * 
   * This is the most direct and accurate method for commit-specific queries.
   * 
   * BRANCH SUPPORT:
   * - If commit is provided, it takes precedence (branch is ignored)
   * - If branch is provided without commit, we find the latest commit on that branch
   * - If neither is provided, we find the latest commit on the default branch
   * 
   * NOTE: This method now uses the foundational resolveAssetContext() method
   * for all asset, branch, and commit resolution.
   */
  async getAssetAttestations(assetIdentifier: string, controlPath?: string, commit?: string, debug?: any, branch?: string): Promise<any[]> {
    console.log(`getAssetAttestations called: asset=${assetIdentifier}, control=${controlPath || 'all'}, branch=${branch || 'default'}, commit=${commit || 'latest'}`);
    
    // Initialize debug object if provided
    if (debug) {
      debug.params = { assetIdentifier, controlPath, commit, branch };
      debug.strategies = [];
    }
    
    // Use the foundational resolver for all asset, branch, and commit resolution
    const context = await this.resolveAssetContext(assetIdentifier, { branch, commit });
    
    // Extract resolved values from context
    const repositoryAssetUuid = context.assetUuid;
    const assetName = context.assetName;
    const projectName = context.projectName;
    const repositoryName = context.repositoryName;
    const applicationVersionUuid = context.applicationVersionUuid;
    const resolvedCommit = context.resolvedCommit || '';
    const resolvedBranch = context.resolvedBranch || '';
    const defaultBranch = context.defaultBranch;
    
    // Also get the repository ID from /assets endpoint (needed for some queries)
    let assetRepositoryId: string | null = context.repositoryId;
    
    // Copy resolution debug info
    if (debug) {
      debug.assetResolution = context.debug?.assetResolution;
      debug.branchResolution = context.debug?.branchResolution;
      debug.commitResolution = context.debug?.commitResolution;
    }
    
    // Normalize control path for flexible matching
    const normalizedControlPath = controlPath?.toLowerCase().replace(/[^a-z0-9.]/g, '');
    
    let attestationUuids: string[] = [];
    
    console.log(`Using resolved context: asset=${repositoryAssetUuid}, commit=${resolvedCommit || 'none'}, branch=${resolvedBranch || 'default'}`);
    
    try {
      
      // Helper to extract attestation UUIDs from various note structures
      const extractNoteUuids = (notes: any[], typeFilter: string | null = 'attestation'): string[] => {
        const uuids: string[] = [];
        for (const note of notes) {
          const noteType = note.type || note.note?.type;
          const uuid = note.uuid || note.note?.uuid;
          
          // Include if no type filter or type matches
          if (uuid && (!typeFilter || noteType === typeFilter)) {
            if (!uuids.includes(uuid)) {
              uuids.push(uuid);
            }
          }
          
          // Also check for nested attestations in notes array response
          if (note.attestations && Array.isArray(note.attestations)) {
            for (const att of note.attestations) {
              const attUuid = att.uuid || att.note?.uuid;
              if (attUuid && !uuids.includes(attUuid)) {
                uuids.push(attUuid);
              }
            }
          }
        }
        return uuids;
      };
      
      // Strategy 1a: Use /notes with repositoryId + commit (most specific)
      // Try WITHOUT type filter first - attestations are often child notes
      // Use assetRepositoryId from /assets if available, otherwise fall back to repositoryAssetUuid
      const effectiveRepoId = assetRepositoryId || repositoryAssetUuid;
      console.log(`Checking Strategy 1a preconditions: effectiveRepoId=${effectiveRepoId}, resolvedCommit=${resolvedCommit}`);
      if (debug) {
        debug.strategy1aPreconditions = { 
          assetRepositoryId, 
          repositoryAssetUuid, 
          effectiveRepoId,
          originalCommit: commit,
          resolvedCommit, 
          meetsConditions: !!(effectiveRepoId && resolvedCommit) 
        };
      }
      // Strategy 1a: Use /notes with commit + type=attestation (most reliable based on API testing)
      // NOTE: /evidence/notes with repositoryId doesn't work, but /notes?commit=...&type=attestation does
      if (resolvedCommit) {
        try {
          const queryParams = new URLSearchParams();
          queryParams.set('commit', resolvedCommit);
          queryParams.set('type', 'attestation');
          
          const url = `/notes?${queryParams.toString()}`;
          console.log(`[Strategy 1a] Fetching attestations from: ${url}`);
          
          const notesData = await this.fetch<any>(url);
          console.log(`[Strategy 1a] Raw API response type: ${typeof notesData}, isArray: ${Array.isArray(notesData)}`);
          console.log(`[Strategy 1a] Raw API response keys: ${notesData ? Object.keys(notesData).slice(0, 10).join(', ') : 'null'}`);
          console.log(`[Strategy 1a] Raw API response sample: ${JSON.stringify(notesData).substring(0, 500)}`);
          const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
          console.log(`[Strategy 1a] Parsed notes array length: ${notes.length}`);
          
          // Capture debug info
          if (debug) {
            debug.strategies.push({
              name: 'Strategy 1a: /notes with commit+type=attestation',
              url,
              responseType: typeof notesData,
              isArray: Array.isArray(notesData),
              responseKeys: notesData ? Object.keys(notesData).slice(0, 10) : [],
              responseSample: JSON.stringify(notesData).substring(0, 1000),
              notesFound: notes.length,
            });
          }
          
          // Log note types found for debugging
          const noteTypes = notes.map((n: any) => n.type || n.note?.type || 'unknown');
          console.log(`[Strategy 1a] Note types found: ${[...new Set(noteTypes)].join(', ')}`);
          
          // If we found notes but they're not attestations, try /notes/:uuid/chain on each
          const originUuids = extractNoteUuids(notes, null); // All notes
          console.log(`[Strategy 1a] Found ${originUuids.length} note UUIDs`);
          
          // First, directly extract attestations
          attestationUuids.push(...extractNoteUuids(notes, 'attestation'));
          console.log(`[Strategy 1a] Direct attestations: ${attestationUuids.length}`);
          
          // If no direct attestations but we found other notes, use /chain to get full event chain
          if (attestationUuids.length === 0 && originUuids.length > 0) {
            console.log(`[Strategy 1a] No direct attestations, trying /chain on ${originUuids.length} notes`);
            for (const noteUuid of originUuids.slice(0, 5)) { // Limit to avoid too many calls
              try {
                const chainUrl = `/evidence/notes/${noteUuid}/chain`;
                console.log(`[Strategy 1a-chain] Fetching chain: ${chainUrl}`);
                const chainData = await this.fetch<any>(chainUrl);
                const chainNotes = Array.isArray(chainData) ? chainData : (chainData.notes || chainData.data || [chainData]);
                const chainAttestations = extractNoteUuids(chainNotes, 'attestation');
                for (const attUuid of chainAttestations) {
                  if (!attestationUuids.includes(attUuid)) {
                    attestationUuids.push(attUuid);
                  }
                }
                console.log(`[Strategy 1a-chain] Chain for ${noteUuid} yielded ${chainAttestations.length} attestations`);
              } catch (chainError) {
                console.log(`[Strategy 1a-chain] Chain failed for ${noteUuid}: ${chainError}`);
              }
            }
          }
          
          console.log(`[Strategy 1a] Total attestations after chain: ${attestationUuids.length}`);
        } catch (e) {
          console.log(`[Strategy 1a] /notes with repositoryId+commit failed: ${e}`);
        }
      }
      
      // Strategy 1b: Use /notes with project + repository + commit
      if (attestationUuids.length === 0 && projectName && repositoryName && commit) {
        try {
          const queryParams = new URLSearchParams();
          queryParams.set('project', projectName);
          queryParams.set('repository', repositoryName);
          queryParams.set('commit', commit);
          // Don't filter by type initially
          
          const url = `/evidence/notes?${queryParams.toString()}`;
          console.log(`[Strategy 1b] Fetching ALL notes from: ${url}`);
          
          const notesData = await this.fetch<any>(url);
          const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
          console.log(`[Strategy 1b] Raw response contains ${notes.length} notes`);
          
          // Extract attestations directly and via chain
          attestationUuids.push(...extractNoteUuids(notes, 'attestation'));
          
          // Try chain if no direct attestations
          if (attestationUuids.length === 0) {
            const originUuids = extractNoteUuids(notes, null);
            for (const noteUuid of originUuids.slice(0, 5)) {
              try {
                const chainData = await this.fetch<any>(`/evidence/notes/${noteUuid}/chain`);
                const chainNotes = Array.isArray(chainData) ? chainData : (chainData.notes || chainData.data || [chainData]);
                const chainAttestations = extractNoteUuids(chainNotes, 'attestation');
                for (const attUuid of chainAttestations) {
                  if (!attestationUuids.includes(attUuid)) {
                    attestationUuids.push(attUuid);
                  }
                }
              } catch (chainError) {
                console.log(`[Strategy 1b-chain] Chain failed: ${chainError}`);
              }
            }
          }
          
          console.log(`[Strategy 1b] Found ${attestationUuids.length} attestations from /notes with project+repository+commit`);
        } catch (e) {
          console.log(`[Strategy 1b] /notes with project+repository+commit failed: ${e}`);
        }
      }
      
      // Strategy 1c: Use /notes with just commit (broad search across org)
      if (attestationUuids.length === 0 && commit) {
        try {
          const queryParams = new URLSearchParams();
          queryParams.set('commit', commit);
          // No type filter - get all notes for this commit
          
          const url = `/evidence/notes?${queryParams.toString()}`;
          console.log(`[Strategy 1c] Fetching ALL notes from: ${url}`);
          
          const notesData = await this.fetch<any>(url);
          const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
          console.log(`[Strategy 1c] Raw response contains ${notes.length} notes for commit ${commit}`);
          
          // Extract attestations directly
          attestationUuids.push(...extractNoteUuids(notes, 'attestation'));
          
          // Try chain if no direct attestations
          if (attestationUuids.length === 0) {
            const originUuids = extractNoteUuids(notes, null);
            console.log(`[Strategy 1c] Found ${originUuids.length} origin/occurrence notes, checking chains...`);
            for (const noteUuid of originUuids.slice(0, 10)) {
              try {
                const chainData = await this.fetch<any>(`/evidence/notes/${noteUuid}/chain`);
                const chainNotes = Array.isArray(chainData) ? chainData : (chainData.notes || chainData.data || [chainData]);
                const chainAttestations = extractNoteUuids(chainNotes, 'attestation');
                for (const attUuid of chainAttestations) {
                  if (!attestationUuids.includes(attUuid)) {
                    attestationUuids.push(attUuid);
                  }
                }
              } catch (chainError) {
                // Silently continue
              }
            }
          }
          
          console.log(`[Strategy 1c] Found ${attestationUuids.length} attestations from /notes with commit only`);
        } catch (e) {
          console.log(`[Strategy 1c] /notes with commit failed: ${e}`);
        }
      }
      
      // Strategy 1d: Use /notes with repositoryId only (no commit filter - latest)
      if (attestationUuids.length === 0 && repositoryAssetUuid) {
        try {
          const queryParams = new URLSearchParams();
          queryParams.set('repositoryId', repositoryAssetUuid);
          queryParams.set('type', 'attestation'); // Filter to attestations for "latest" query
          
          const url = `/evidence/notes?${queryParams.toString()}`;
          console.log(`[Strategy 1d] Fetching from: ${url}`);
          
          const notesData = await this.fetch<any>(url);
          const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
          
          attestationUuids.push(...extractNoteUuids(notes, null)); // Include all from response
          console.log(`[Strategy 1d] Found ${attestationUuids.length} attestations from /notes with repositoryId only`);
        } catch (e) {
          console.log(`[Strategy 1d] /notes with repositoryId failed: ${e}`);
        }
      }
      
      // Strategy 2: Use /evidence/assets/{uuid}/attestations endpoint as fallback
      if (repositoryAssetUuid && attestationUuids.length === 0) {
        try {
          let url = `/evidence/assets/${encodeURIComponent(repositoryAssetUuid)}/attestations`;
          if (commit) {
            url += `?commit=${encodeURIComponent(commit)}`;
          }
          console.log(`[Strategy 2] Fetching from: ${url}`);
          
          const data = await this.fetch<any>(url);
          const attestations = Array.isArray(data) ? data : (data.attestations || data.notes || []);
          
          for (const att of attestations) {
            const uuid = att.uuid || att.note?.uuid;
            if (uuid && !attestationUuids.includes(uuid)) {
              attestationUuids.push(uuid);
            }
          }
          console.log(`[Strategy 2] Found ${attestationUuids.length} attestations from /evidence/assets/{uuid}/attestations`);
        } catch (e) {
          console.log(`[Strategy 2] /evidence/assets/{uuid}/attestations failed: ${e}`);
        }
      }
      
      // Strategy 3: Try /evidence/assets/{uuid}/attestations/snapshot as backup
      if (repositoryAssetUuid && attestationUuids.length === 0) {
        try {
          let snapshotUrl = `/evidence/assets/${encodeURIComponent(repositoryAssetUuid)}/attestations/snapshot`;
          if (commit) {
            snapshotUrl += `?commit=${encodeURIComponent(commit)}`;
          }
          console.log(`[Strategy 3] Fetching from: ${snapshotUrl}`);
          
          const snapshotData = await this.fetch<AssetAttestationSnapshotResponse>(snapshotUrl);
          
          if (snapshotData.attestations) {
            for (const att of snapshotData.attestations) {
              if (att.uuid && !attestationUuids.includes(att.uuid)) {
                attestationUuids.push(att.uuid);
              }
            }
          }
          console.log(`[Strategy 3] Found ${attestationUuids.length} attestations from snapshot endpoint`);
        } catch (e) {
          console.log(`[Strategy 3] Snapshot endpoint failed: ${e}`);
        }
      }
      
      // Strategy 4: Try org compliance attestations as final fallback (no commit filter)
      if (attestationUuids.length === 0) {
        console.log('[Strategy 4] Falling back to org compliance attestations');
        for (const app of applications) {
          const appMatches = 
            app.app_name?.toLowerCase().includes(assetIdentifier.toLowerCase()) ||
            app.app_code?.toLowerCase().includes(assetIdentifier.toLowerCase()) ||
            app.identifier?.toLowerCase().includes(assetIdentifier.toLowerCase());
          
          if (appMatches) {
            if (app.attestations) {
              for (const att of app.attestations) {
                if (att.uuid && !attestationUuids.includes(att.uuid)) {
                  attestationUuids.push(att.uuid);
                }
              }
            }
            for (const asset of app.assets || []) {
              if (asset.attestations) {
                for (const att of asset.attestations) {
                  if (att.uuid && !attestationUuids.includes(att.uuid)) {
                    attestationUuids.push(att.uuid);
                  }
                }
              }
            }
            break;
          }
        }
        console.log(`[Strategy 4] Found ${attestationUuids.length} attestations from org compliance`);
      }
      
      if (attestationUuids.length === 0) {
        console.log('No attestation UUIDs found from any strategy');
        return [];
      }
      
      // Fetch full details for each attestation using direct UUID lookup
      console.log(`Fetching full details for ${attestationUuids.length} attestations...`);
      
      const detailedAttestations: any[] = [];
      
      // Fetch in parallel with limited concurrency
      const batchSize = 10;
      for (let i = 0; i < attestationUuids.length; i += batchSize) {
        const batch = attestationUuids.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (uuid) => {
            try {
              const details = await this.getAttestationDetails(uuid);
              return details;
            } catch (e) {
              console.warn(`Failed to fetch attestation ${uuid}:`, e);
              return null;
            }
          })
        );
        
        for (const result of batchResults) {
          if (result) {
            detailedAttestations.push(result);
          }
        }
      }
      
      console.log(`Successfully fetched details for ${detailedAttestations.length} attestations`);
      
      // Client-side filtering by control path (if API didn't filter or partial match needed)
      let filteredAttestations = detailedAttestations;
      
      if (normalizedControlPath) {
        console.log(`Filtering by control path: ${normalizedControlPath}`);
        filteredAttestations = detailedAttestations.filter(att => {
          const attControlPath = (att.control?.path || att.note?.path || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
          const controlName = (att.control?.name || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
          
          return attControlPath.includes(normalizedControlPath) ||
                 controlName.includes(normalizedControlPath) ||
                 normalizedControlPath.includes(attControlPath) ||
                 normalizedControlPath.includes(controlName);
        });
        console.log(`After control path filter: ${filteredAttestations.length} attestations`);
      }
      
      // Client-side filtering by commit (backup if API didn't filter correctly)
      if (commit && filteredAttestations.length > 0) {
        console.log(`Verifying commit filter: ${commit}`);
        const commitLower = commit.toLowerCase();
        const commitFiltered = filteredAttestations.filter(att => {
          const attCommit = (att.asset?.version?.commit || att.commit || '').toLowerCase();
          return attCommit.startsWith(commitLower) || commitLower.startsWith(attCommit);
        });
        
        if (commitFiltered.length > 0) {
          filteredAttestations = commitFiltered;
          console.log(`After commit filter: ${filteredAttestations.length} attestations`);
        } else {
          console.log(`No attestations matched commit ${commit}, keeping all ${filteredAttestations.length} results`);
        }
      }
      
      return filteredAttestations;
    } catch (error) {
      console.error(`Failed to get asset attestations for ${assetIdentifier}:`, error);
      return [];
    }
  }

  /**
   * Enrich attestation objects with control names from the controls API
   */
  private async enrichAttestationControlNames(attestations: any[]): Promise<void> {
    if (attestations.length === 0) return;
    
    try {
      const controlsData = await this.fetch<any[]>(`/console/controls`).catch(() => []);
      
      // Build lookup map
      const controlMap = new Map<string, { name: string; path: string }>();
      for (const control of controlsData || []) {
        const key = control.uuid || control.id || control.entityId;
        const info = {
          name: control.displayKey || control.name || control.path,
          path: control.path || '',
        };
        if (key) controlMap.set(key, info);
        if (control.path) controlMap.set(control.path, info);
      }

      // Enrich each attestation
      for (const att of attestations) {
        const entityId = att.control?.entityId || att.control?.name;
        if (entityId) {
          const controlInfo = controlMap.get(entityId);
          if (controlInfo) {
            att.control = {
              ...att.control,
              name: controlInfo.name,
              path: controlInfo.path,
            };
          }
        }
      }
    } catch (error) {
      console.warn('Failed to enrich attestation control names:', error);
    }
  }

  /**
   * Get organization-wide compliance summary
   * Uses /evidence/assets/compliance endpoint for attestation compliance data
   */
  async getComplianceSummary(): Promise<ComplianceSummary> {
    const cacheKey = `summary:${this.session.tenantId}`;
    
    const cached = await this.getFromCache<ComplianceSummary>(cacheKey);
    if (cached) {
      return cached;
    }

    // Fetch organizational compliance data using the correct endpoint
    // API returns: ApplicationCompliance[] with attestations and assets
    const complianceData = await this.fetch<ApplicationComplianceResponse[]>(
      `/evidence/assets/compliance`
    );

    // Handle response - could be array or wrapped object
    const applications = Array.isArray(complianceData) ? complianceData : [];
    
    // Aggregate metrics across all applications
    let totalAssets = 0;
    let compliantAssets = 0;
    let nonCompliantAssets = 0;
    let totalPassing = 0;
    let totalFailing = 0;
    let criticalIssues = 0;
    let highIssues = 0;

    for (const app of applications) {
      // Count assets from both top-level attestations and nested assets
      const attestations = app.attestations || [];
      const assets = app.assets || [];
      
      // Each application is an asset to count
      totalAssets++;
      
      // Count attestation results
      let appPassing = 0;
      let appFailing = 0;
      
      for (const attestation of attestations) {
        // Skip null/undefined attestations (can happen in some tenant data)
        if (!attestation) continue;
        
        if (attestation.status === 'pass' || attestation.result === 'pass') {
          appPassing++;
          totalPassing++;
        } else if (attestation.status === 'fail' || attestation.result === 'fail') {
          appFailing++;
          totalFailing++;
          // Count as critical/high issues based on status
          if (attestation.status === 'fail') {
            highIssues++;
          }
        }
      }
      
      // Also count nested asset attestations
      for (const asset of assets) {
        // Skip null/undefined assets
        if (!asset) continue;
        
        totalAssets++;
        let assetPassing = 0;
        let assetFailing = 0;
        
        for (const attestation of asset.attestations || []) {
          // Skip null/undefined attestations
          if (!attestation) continue;
          
          if (attestation.status === 'pass' || attestation.result === 'pass') {
            assetPassing++;
            totalPassing++;
          } else if (attestation.status === 'fail' || attestation.result === 'fail') {
            assetFailing++;
            totalFailing++;
            highIssues++;
          }
        }
        
        // Determine asset compliance
        if (assetFailing === 0 && assetPassing > 0) {
          compliantAssets++;
        } else if (assetFailing > 0) {
          nonCompliantAssets++;
        }
      }
      
      // Determine app compliance
      if (appFailing === 0 && appPassing > 0) {
        compliantAssets++;
      } else if (appFailing > 0) {
        nonCompliantAssets++;
      }
    }

    // Calculate overall score
    const totalChecks = totalPassing + totalFailing;
    const overallScore = totalChecks > 0 ? totalPassing / totalChecks : 0;

    const result: ComplianceSummary = {
      tenant: {
        id: this.session.tenantId,
        name: 'Organization',
      },
      overallScore,
      totalAssets,
      compliantAssets,
      nonCompliantAssets,
      criticalIssues,
      highIssues,
      frameworks: [],
      lastUpdated: new Date().toISOString(),
    };

    // Cache for 10 minutes
    await this.setCache(cacheKey, result, 600);

    return result;
  }

  /**
   * Get raw organization compliance data for detailed analysis
   * Returns ApplicationComplianceResponse[] with full attestation and asset data
   */
  async getOrganizationCompliance(): Promise<ApplicationComplianceResponse[]> {
    const cacheKey = `org-compliance:${this.session.tenantId}`;
    
    const cached = await this.getFromCache<ApplicationComplianceResponse[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const complianceData = await this.fetch<ApplicationComplianceResponse[]>(
      `/evidence/assets/compliance`
    );

    const applications = Array.isArray(complianceData) ? complianceData : [];
    
    // Cache for 5 minutes
    await this.setCache(cacheKey, applications, 300);

    return applications;
  }

  /**
   * Resolve an application by name, code, or UUID
   * 
   * This is the canonical way to find an application across all tools.
   * Supports fuzzy matching on:
   * - Application name (e.g., "Digital Banking Experience")
   * - Application code (e.g., "DBX")  
   * - Application UUID/identifier
   * 
   * @param searchTerm - Name, code, or UUID to search for
   * @returns Resolved application info or not found
   */
  async resolveApplication(searchTerm: string): Promise<{
    found: boolean;
    uuid?: string;
    name?: string;
    code?: string;
    type?: string;
    assets?: Array<{
      uuid: string;
      name: string;
      type: string;
      repository?: string;
    }>;
    raw?: any; // Full raw application data for advanced use
  }> {
    console.log(`[resolveApplication] Searching for: "${searchTerm}"`);
    
    const orgCompliance = await this.getOrganizationCompliance();
    const searchLower = searchTerm.toLowerCase().trim();
    
    // Search through all applications
    for (const app of orgCompliance) {
      const appName = app.app_name?.toLowerCase() || '';
      const appCode = String(app.app_code || '').toLowerCase();
      const appIdentifier = app.identifier?.toLowerCase() || '';
      
      // Check for exact or partial match
      if (appName.includes(searchLower) ||
          appCode.includes(searchLower) ||
          appCode === searchLower ||
          appIdentifier === searchLower ||
          appIdentifier.includes(searchLower)) {
        
        console.log(`[resolveApplication] Found match: ${app.app_name} (code: ${app.app_code})`);
        
        return {
          found: true,
          uuid: app.identifier || app.version_uuid,
          name: app.app_name,
          code: String(app.app_code || ''),
          type: app.type || 'application',
          assets: (app.assets || []).map((a: any) => ({
            uuid: a.uuid,
            name: a.name || a.repository || a.uuid,
            type: a.type || 'repository',
            repository: a.repository,
          })),
          raw: app,
        };
      }
    }
    
    console.log(`[resolveApplication] No application found for: "${searchTerm}"`);
    
    // Return available applications for hints
    return {
      found: false,
    };
  }

  /**
   * Get list of all available applications (for hints/autocomplete)
   */
  async listAvailableApplications(): Promise<Array<{ name: string; code: string; uuid: string }>> {
    const orgCompliance = await this.getOrganizationCompliance();
    return orgCompliance.map(app => ({
      name: app.app_name || '',
      code: String(app.app_code || ''),
      uuid: app.identifier || app.version_uuid || '',
    }));
  }

  /**
   * Generic fetch method with authentication, error handling, and audit logging
   * Logs full request/response details for usage analytics
   */
  async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.session.accessToken}`,
          'X-Tenant-ID': this.session.tenantId,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const duration = Date.now() - startTime;

      // Read response as text first to capture size
      const responseText = await response.text();
      const responseSize = responseText.length;

      // Audit log the API call with response size
      await this.logApiCall(endpoint, response.status, duration, response.ok, responseSize);
      
      // Console log for wrangler tail (full details)
      console.log(`[API] ${response.ok ? 'OK' : 'ERR'} ${response.status} ${endpoint} (${duration}ms, ${responseSize} bytes)`);

      if (!response.ok) {
        // Log security-relevant errors
        if (response.status === 403) {
          console.error('[SECURITY] Tenant access denied', JSON.stringify({
            timestamp: new Date().toISOString(),
            userId: this.session.userId,
            tenantId: this.session.tenantId,
            endpoint,
            status: response.status,
            response: responseText.substring(0, 500),
          }));
        }

        throw new Error(
          `Consulta API error: ${response.status} ${response.statusText} - ${responseText}`
        );
      }

      // Parse JSON from the text we already read
      return JSON.parse(responseText) as T;
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.logApiCall(endpoint, 0, duration, false, 0);
      
      console.error(`[API] FAIL ${endpoint} (${duration}ms)`, error instanceof Error ? error.message : String(error));
      
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Consulta API request failed: ${String(error)}`);
    }
  }

  /**
   * Get data from KV cache
   */
  private async getFromCache<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.env.CACHE_KV.get(key, 'json');
      if (cached) {
        console.log(`Cache hit: ${key}`);
        return cached as T;
      }
    } catch (error) {
      console.warn(`Cache get error for ${key}:`, error);
    }
    return null;
  }

  /**
   * Set data in KV cache with TTL
   */
  private async setCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.env.CACHE_KV.put(key, JSON.stringify(value), {
        expirationTtl: ttlSeconds,
      });
      console.log(`Cache set: ${key} (TTL: ${ttlSeconds}s)`);
    } catch (error) {
      console.warn(`Cache set error for ${key}:`, error);
    }
  }

  /**
   * Log API call to Analytics Engine for audit trail
   */
  private async logApiCall(
    endpoint: string,
    statusCode: number,
    durationMs: number,
    success: boolean,
    responseSize?: number
  ): Promise<void> {
    try {
      await this.env.ANALYTICS.writeDataPoint({
        blobs: [
          'consulta_api_call',                              // blob1: event type
          endpoint,                                          // blob2: API endpoint
          this.session.userId || 'anonymous',                // blob3: user ID
          this.session.tenantId || 'unknown',                // blob4: tenant ID
          success ? 'success' : 'failure',                   // blob5: status
          new Date().toISOString(),                          // blob6: timestamp
        ],
        doubles: [
          durationMs,                                        // double1: duration ms
          statusCode,                                        // double2: HTTP status code
          responseSize || 0,                                 // double3: response size bytes
        ],
        indexes: [success ? 'success' : 'failure'],
      });
    } catch (error) {
      console.error('Failed to log API call to Analytics Engine:', error);
    }
  }

  // ============================================================
  // DEPLOYMENT/RELEASE METHODS
  // ============================================================

  /**
   * Get deployment history for an asset
   * Uses /deployments/assets/:asset/environments endpoint
   * 
   * @param assetUuid - Asset UUID
   * @param environment - Optional environment filter (e.g., "QA", "PROD")
   * @param count - Number of deployments to return (default 10)
   */
  async getAssetDeployments(
    assetUuid: string,
    environment?: string,
    count: number = 10
  ): Promise<DeploymentRecord[]> {
    try {
      console.log(`Fetching deployments for asset ${assetUuid}, environment=${environment || 'all'}`);
      
      // First, try the /evidence/deployments endpoint
      let endpoint: string;
      if (environment) {
        endpoint = `/evidence/deployments/assets/${encodeURIComponent(assetUuid)}/environments/${encodeURIComponent(environment)}`;
      } else {
        endpoint = `/evidence/deployments/assets/${encodeURIComponent(assetUuid)}/environments`;
      }
      
      let deployments: DeploymentRecord[] = [];
      
      try {
        const data = await this.fetch<any>(endpoint);
        
        // Handle different response shapes
        if (Array.isArray(data)) {
          for (const d of data) {
            deployments.push(this.normalizeDeploymentRecord(d));
          }
        } else if (data.deployments) {
          for (const d of data.deployments) {
            deployments.push(this.normalizeDeploymentRecord(d));
          }
        } else if (data.releases) {
          for (const r of data.releases) {
            deployments.push(this.normalizeDeploymentRecord(r));
          }
        } else if (data.uuid) {
          deployments.push(this.normalizeDeploymentRecord(data));
        }
      } catch (e) {
        console.log(`/evidence/deployments endpoint failed, falling back to transaction notes`);
      }
      
      // If no deployments found from /evidence/deployments, try transaction notes
      // Deployments are stored as transaction notes with path=transaction.gating.enforce.record
      if (deployments.length === 0) {
        console.log(`Trying transaction notes for deployment history...`);
        const notesData = await this.fetch<any>(`/notes?type=transaction&limit=${count * 5}`);
        const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
        
        // Filter for enforce records matching this asset
        for (const note of notes) {
          // Check if this is an enforce record (actual deployment)
          if (note.path !== 'transaction.gating.enforce.record') continue;
          
          // Check if it matches the asset UUID
          if (note.asset?.uuid !== assetUuid) continue;
          
          // Extract deployment info from the transaction note
          const deployment: DeploymentRecord = {
            uuid: note.uuid,
            timestamp: note.timestamp || note.origination,
            commit: note.asset?.scm?.repository?.commit || '',
            artifact: note.asset?.version?.artifact,
            tag: note.asset?.scm?.repository?.tag,
            environment: note.target?.environment || note.gate?.environment || '',
            environmentName: note.target?.environmentName || note.gate?.name || '',
            target: note.target?.uuid || note.target?.path,
            targetName: note.target?.name || note.target?.displayKey,
            status: note.status,
            result: note.result || (note.detail?.required?.code === 1 ? 'pass' : 'fail'),
          };
          
          deployments.push(deployment);
          
          if (deployments.length >= count) break;
        }
      }
      
      // Sort by timestamp descending (most recent first)
      deployments.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
      
      console.log(`Found ${deployments.length} deployments for asset ${assetUuid}`);
      return deployments.slice(0, count);
    } catch (error) {
      console.warn(`Failed to fetch deployments for asset ${assetUuid}:`, error);
      return [];
    }
  }

  /**
   * Get release history for a component (alternative endpoint)
   * Uses /component/:component/releases endpoint
   */
  async getComponentReleases(componentUuid: string): Promise<DeploymentRecord[]> {
    try {
      console.log(`Fetching releases for component ${componentUuid}`);
      
      const data = await this.fetch<any>(`/component/${encodeURIComponent(componentUuid)}/releases`);
      
      const releases: DeploymentRecord[] = [];
      const releaseArray = Array.isArray(data) ? data : (data.releases || data.data || []);
      
      for (const r of releaseArray) {
        releases.push(this.normalizeDeploymentRecord(r));
      }
      
      console.log(`Found ${releases.length} releases for component ${componentUuid}`);
      return releases;
    } catch (error) {
      console.warn(`Failed to fetch releases for component ${componentUuid}:`, error);
      return [];
    }
  }

  /**
   * Get the latest deployment for an asset to a specific environment
   */
  async getLatestDeployment(
    assetUuid: string,
    environment?: string
  ): Promise<DeploymentRecord | null> {
    const deployments = await this.getAssetDeployments(assetUuid, environment, 1);
    return deployments.length > 0 ? deployments[0] : null;
  }

  /**
   * Normalize deployment record from various API response formats
   */
  private normalizeDeploymentRecord(data: any): DeploymentRecord {
    return {
      uuid: data.uuid || data.release || data.id,
      timestamp: data.timestamp || data.created_at || data.date,
      commit: data.commit || data.asset_commit || data.assetCommit,
      artifact: data.artifact || data.asset_artifact || data.assetArtifact,
      tag: data.tag || data.asset_tag || data.assetTag,
      environment: data.environment || data.environment_name || data.environmentName || '',
      environmentName: data.environment_name || data.environmentName || data.environment,
      target: data.target || data.target_name || '',
      targetName: data.target_name || data.targetName || data.target,
      changeRecord: data.change_record || data.changeRecord,
      status: data.status,
      result: data.result,
      evidence: data.evidence || [],
    };
  }

  /**
   * Get attestations associated with a specific deployment
   * This fetches the evidence/notes that were part of a deployment decision
   */
  async getDeploymentAttestations(deploymentUuid: string): Promise<any[]> {
    try {
      console.log(`Fetching attestations for deployment ${deploymentUuid}`);
      
      // Try to get release details which includes evidence
      const releaseData = await this.fetch<any>(`/releases/${encodeURIComponent(deploymentUuid)}`);
      
      const attestations: any[] = [];
      
      // Extract evidence references from the release
      if (releaseData.evidence) {
        for (const ev of releaseData.evidence) {
          const noteUuid = ev.note || ev.uuid;
          if (noteUuid) {
            try {
              const noteDetails = await this.getAttestationDetails(noteUuid);
              if (noteDetails) {
                attestations.push(noteDetails);
              }
            } catch (e) {
              console.warn(`Failed to fetch note ${noteUuid}:`, e);
            }
          }
        }
      }
      
      // Also check for assets with evidence
      if (releaseData.assets) {
        for (const asset of releaseData.assets) {
          if (asset.evidence) {
            for (const ev of asset.evidence) {
              const noteUuid = ev.note || ev.uuid;
              if (noteUuid && !attestations.find(a => a.uuid === noteUuid)) {
                try {
                  const noteDetails = await this.getAttestationDetails(noteUuid);
                  if (noteDetails) {
                    attestations.push(noteDetails);
                  }
                } catch (e) {
                  console.warn(`Failed to fetch note ${noteUuid}:`, e);
                }
              }
            }
          }
        }
      }
      
      console.log(`Found ${attestations.length} attestations for deployment ${deploymentUuid}`);
      return attestations;
    } catch (error) {
      console.warn(`Failed to fetch attestations for deployment ${deploymentUuid}:`, error);
      return [];
    }
  }

  /**
   * List available environments for the tenant
   */
  async listEnvironments(): Promise<Array<{ uuid: string; name: string; entityKey: string }>> {
    try {
      const data = await this.fetch<any[]>(`/environments`);
      
      if (!Array.isArray(data)) {
        return [];
      }
      
      return data.map(env => ({
        uuid: env.uuid || env.id,
        name: env.name || env.displayKey || env.entityKey,
        entityKey: env.entityKey || env.entity_key || env.path,
      }));
    } catch (error) {
      console.warn('Failed to list environments:', error);
      return [];
    }
  }

  /**
   * Get commit history for an asset
   * Returns commits sorted by timestamp (most recent first)
   */
  async getAssetCommits(assetUuid: string): Promise<Array<{ commit: string; timestamp?: string; branches?: string[] }>> {
    try {
      const commitsUrl = `/assets/${encodeURIComponent(assetUuid)}/commits`;
      const data = await this.fetch<any[]>(commitsUrl);
      
      if (!Array.isArray(data)) {
        return [];
      }
      
      // Sort by timestamp descending (most recent first)
      const commits = data.map(c => ({
        commit: c.commit,
        timestamp: c.timestamp || c.created_at || c.date,
        branches: c.branches || c.refs || [],
      }));
      
      commits.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
      
      return commits;
    } catch (error) {
      console.warn(`Failed to get commits for asset ${assetUuid}:`, error);
      return [];
    }
  }

  // ============================================================
  // EVIDENCE CHAIN METHODS
  // ============================================================

  /**
   * Get the evidence chain (upstream lineage) for a note
   * Returns array of notes from origin to the specified note
   * 
   * @param noteUuid - UUID of the note to trace
   * @returns Array of notes in chain order (origin first)
   */
  async getEvidenceChain(noteUuid: string): Promise<any[]> {
    try {
      console.log(`Fetching evidence chain for note: ${noteUuid}`);
      const chainUrl = `/evidence/notes/${encodeURIComponent(noteUuid)}/chain`;
      const chainData = await this.fetch<any>(chainUrl);
      
      // Chain endpoint returns an array of notes
      if (Array.isArray(chainData)) {
        console.log(`Evidence chain has ${chainData.length} nodes`);
        return chainData;
      }
      
      // Handle wrapped response
      if (chainData.chain) {
        return chainData.chain;
      }
      if (chainData.notes) {
        return chainData.notes;
      }
      
      // Single item response
      return [chainData];
    } catch (error) {
      console.warn(`Failed to get evidence chain for ${noteUuid}:`, error);
      return [];
    }
  }

  /**
   * Get notes by commit SHA
   * 
   * @param commit - Full or short commit SHA
   * @param type - Optional filter by note type (origin, occurrence, attestation, transaction)
   * @returns Array of notes for the commit
   */
  async getNotesByCommit(commit: string, type?: string): Promise<any[]> {
    try {
      console.log(`Fetching notes for commit: ${commit}, type: ${type || 'all'}`);
      const queryParams = new URLSearchParams();
      queryParams.set('commit', commit);
      if (type) {
        queryParams.set('type', type);
      }
      queryParams.set('limit', '100');
      
      const url = `/notes?${queryParams.toString()}`;
      const notesData = await this.fetch<any>(url);
      
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      console.log(`Found ${notes.length} notes for commit ${commit}`);
      return notes;
    } catch (error) {
      console.warn(`Failed to get notes for commit ${commit}:`, error);
      return [];
    }
  }

  /**
   * Get notes that have a specific parent UUID
   * Used for downstream traversal of evidence chain
   * 
   * @param parentUuid - UUID of the parent note
   * @returns Array of child notes
   */
  async getNotesByParent(parentUuid: string): Promise<any[]> {
    try {
      console.log(`Fetching child notes for parent: ${parentUuid}`);
      const queryParams = new URLSearchParams();
      queryParams.set('parent', parentUuid);
      queryParams.set('limit', '100');
      
      const url = `/notes?${queryParams.toString()}`;
      const notesData = await this.fetch<any>(url);
      
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      console.log(`Found ${notes.length} child notes for parent ${parentUuid}`);
      return notes;
    } catch (error) {
      console.warn(`Failed to get child notes for parent ${parentUuid}:`, error);
      return [];
    }
  }

  // ============================================================
  // POLICY VIOLATIONS METHODS
  // ============================================================

  /**
   * Get failing attestations across the organization or for a specific asset
   * This is the foundation for "Policy Violations as First-Class Concept"
   * 
   * @param options - Query options
   * @returns Array of policy violations (failing attestations)
   */
  // In-memory cache for controls (per request/instance)
  private controlsCache: Map<string, { name: string; severity: string | null }> | null = null;
  private controlsCacheHasSeverity: boolean = false;

  async getFailingAttestations(options: {
    assetIdentifier?: string;
    controlPath?: string;
    severity?: string;
    since?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const { assetIdentifier, controlPath, severity, since, limit = 100 } = options;
    const startTime = Date.now();
    
    console.log(`[getFailingAttestations] Starting: asset=${assetIdentifier || 'all'}, control=${controlPath || 'all'}`);
    
    const violations: any[] = [];
    
    try {
      // Build query for failing attestations - use smaller limit for faster response
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'attestation');
      queryParams.set('result', 'fail');
      // Use smaller batch for faster initial response
      queryParams.set('limit', String(Math.min(limit + 20, 150)));
      
      // Add path filter if control specified
      if (controlPath) {
        queryParams.set('path', controlPath);
      }
      
      // Use server-side time filtering if 'since' is provided
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) {
          queryParams.set('from', sinceDate.toISOString());
          console.log(`[getFailingAttestations] Using server-side time filter: from=${sinceDate.toISOString()}`);
        }
      }
      
      const notesUrl = `/notes?${queryParams.toString()}`;
      console.log(`[getFailingAttestations] Fetching from: ${notesUrl}`);
      
      // Try to get from KV cache first (60 second TTL for failing attestations)
      const cacheKey = `failing_attestations_${controlPath || 'all'}_${Math.min(limit + 20, 150)}`;
      let notes: any[];
      
      const fetchStart = Date.now();
      const cachedData = await this.env.CACHE_KV?.get(cacheKey, 'json').catch(() => null);
      
      if (cachedData) {
        notes = cachedData as any[];
        console.log(`[getFailingAttestations] Cache hit! Retrieved ${notes.length} notes in ${Date.now() - fetchStart}ms`);
      } else {
        const notesData = await this.fetch<any>(notesUrl);
        notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
        console.log(`[getFailingAttestations] Notes fetch took ${Date.now() - fetchStart}ms, found ${notes.length}`);
        
        // Cache for 5 minutes to improve performance (the Consulta API is slow ~25-30s)
        if (this.env.CACHE_KV && notes.length > 0) {
          await this.env.CACHE_KV.put(cacheKey, JSON.stringify(notes), { expirationTtl: 300 }).catch(() => {});
          console.log(`[getFailingAttestations] Cached ${notes.length} notes (TTL: 300s)`);
        }
      }
      
      // If asset specified, resolve it first for filtering
      let targetAssetUuid: string | undefined;
      let targetAssetName: string | undefined;
      
      if (assetIdentifier) {
        const resolveStart = Date.now();
        const context = await this.resolveAssetContext(assetIdentifier);
        targetAssetUuid = context.assetUuid;
        targetAssetName = context.assetName;
        console.log(`[getFailingAttestations] Asset resolve took ${Date.now() - resolveStart}ms: ${targetAssetName} (${targetAssetUuid})`);
      }
      
      // Get control metadata for enrichment - use cached if available
      let controlMap: Map<string, { name: string; severity: string | null }>;
      let hasSeverityData: boolean;
      
      if (this.controlsCache) {
        controlMap = this.controlsCache;
        hasSeverityData = this.controlsCacheHasSeverity;
        console.log(`[getFailingAttestations] Using in-memory cached controls (${controlMap.size} controls)`);
      } else {
        // Try KV cache first for controls
        const controlsCacheKey = `controls_metadata_${this.session.tenantId}`;
        const cachedControls = await this.env.CACHE_KV?.get(controlsCacheKey, 'json').catch(() => null) as any;
        
        if (cachedControls?.data) {
          controlMap = new Map(Object.entries(cachedControls.data));
          hasSeverityData = cachedControls.hasSeverity;
          console.log(`[getFailingAttestations] Using KV cached controls (${controlMap.size} controls)`);
        } else {
          const controlsStart = Date.now();
          const controlsData = await this.fetch<any[]>(`/console/controls`).catch(() => []);
          console.log(`[getFailingAttestations] Controls fetch took ${Date.now() - controlsStart}ms`);
          
          controlMap = new Map<string, { name: string; severity: string | null }>();
          hasSeverityData = false;
          
          for (const ctrl of controlsData || []) {
            const key = ctrl.path || ctrl.uuid;
            if (key) {
              if (ctrl.severity) {
                hasSeverityData = true;
              }
              controlMap.set(key, {
                name: ctrl.displayKey || ctrl.name || ctrl.path,
                severity: ctrl.severity || null,
              });
            }
          }
          
          // Cache to KV for 10 minutes (controls change rarely)
          if (this.env.CACHE_KV && controlMap.size > 0) {
            const cacheData = {
              data: Object.fromEntries(controlMap),
              hasSeverity: hasSeverityData,
            };
            await this.env.CACHE_KV.put(controlsCacheKey, JSON.stringify(cacheData), { expirationTtl: 600 }).catch(() => {});
            console.log(`[getFailingAttestations] Cached controls metadata (TTL: 600s)`);
          }
        }
        
        // Also keep in-memory for this instance
        this.controlsCache = controlMap;
        this.controlsCacheHasSeverity = hasSeverityData;
      }
      
      // If severity filter requested but no controls have severity data, skip filtering
      // and add a warning to the response
      const skipSeverityFilter = severity && !hasSeverityData;
      if (skipSeverityFilter) {
        console.log(`[getFailingAttestations] Warning: severity filter requested but no controls have severity configured`);
      }
      
      // Process notes into violations
      const now = Date.now();
      
      for (const note of notes) {
        // Extract asset info
        const assetUuid = note.asset?.uuid || note.asset;
        const assetName = note.asset?.name || note.asset?.repository || 'Unknown';
        
        // Filter by asset if specified
        if (targetAssetUuid && assetUuid !== targetAssetUuid) {
          // Also check by name for fuzzy matching
          if (!assetName.toLowerCase().includes(assetIdentifier!.toLowerCase())) {
            continue;
          }
        }
        
        // Extract control info
        const notePath = note.path || note.tag || '';
        const controlInfo = controlMap.get(notePath) || { name: notePath, severity: null };
        
        // Filter by severity if specified AND severity data exists
        // If no controls have severity, we skip this filter and return all violations
        if (severity && !skipSeverityFilter && controlInfo.severity !== severity) {
          continue;
        }
        
        // Filter by time if since specified
        const timestamp = note.timestamp || note.origination;
        if (since && timestamp) {
          const noteTime = new Date(timestamp).getTime();
          const sinceTime = new Date(since).getTime();
          if (noteTime < sinceTime) {
            continue;
          }
        }
        
        // Calculate age
        const ageDays = timestamp 
          ? Math.floor((now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24))
          : undefined;
        
        // Extract failure reason from detail or policy
        let reason: string | undefined;
        if (note.detail?.verification?.valid === false) {
          reason = 'Verification failed';
        } else if (note.policy?.evaluation?.logs?.[0]) {
          reason = note.policy.evaluation.logs[0];
        } else if (note.detail?.message) {
          reason = note.detail.message;
        }
        
        violations.push({
          uuid: note.uuid,
          controlPath: notePath,
          controlName: controlInfo.name,
          asset: {
            uuid: assetUuid,
            name: assetName,
            type: note.asset?.type?.name || 'repository',
          },
          commit: note.asset?.version?.commit || note.asset?.scm?.repository?.commit,
          branch: note.declarations?.branch,
          timestamp,
          severity: controlInfo.severity || 'unset', // 'unset' if control has no severity configured
          reason,
          impactedDeployment: false, // Would need cross-reference with transactions
          _severityFilterSkipped: skipSeverityFilter, // Flag to indicate severity filter was skipped
          ageDays,
        });
        
        if (violations.length >= limit) {
          break;
        }
      }
      
      // Sort by timestamp descending (most recent first)
      violations.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
      
      console.log(`[getFailingAttestations] Returning ${violations.length} violations (total time: ${Date.now() - startTime}ms)`);
      return violations;
    } catch (error) {
      console.error(`[getFailingAttestations] Failed after ${Date.now() - startTime}ms:`, error);
      return [];
    }
  }

  /**
   * Get transaction notes (gating decisions) to understand deployment impact
   * 
   * @param options - Query options
   * @returns Array of transaction notes
   */
  async getGatingTransactions(options: {
    assetIdentifier?: string;
    outcome?: 'passed' | 'failed' | 'all';
    limit?: number;
  } = {}): Promise<any[]> {
    const { assetIdentifier, outcome = 'all', limit = 50 } = options;
    
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'transaction');
      queryParams.set('limit', String(limit * 2));
      
      const notesUrl = `/notes?${queryParams.toString()}`;
      const notesData = await this.fetch<any>(notesUrl);
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      
      let filtered = notes;
      
      // Filter by outcome if specified
      if (outcome !== 'all') {
        filtered = notes.filter((n: any) => {
          const code = n.detail?.required?.code;
          if (outcome === 'passed') {
            return code === 1;
          } else {
            return code !== 1;
          }
        });
      }
      
      // Filter by asset if specified
      if (assetIdentifier) {
        const searchLower = assetIdentifier.toLowerCase();
        filtered = filtered.filter((n: any) => {
          const assetName = n.asset?.name || '';
          return assetName.toLowerCase().includes(searchLower);
        });
      }
      
      return filtered.slice(0, limit);
    } catch (error) {
      console.warn(`[getGatingTransactions] Failed:`, error);
      return [];
    }
  }

  /**
   * Get compliance trend data using smart sampling
   * 
   * This method aggregates attestation data over time and samples to ensure
   * fast responses even for large tenants.
   * 
   * @param options - Query options
   * @returns Trend data with sampled data points and control changes
   */
  async getComplianceTrendData(options: {
    assetIdentifier?: string;
    startDate: string;
    endDate: string;
    maxDataPoints?: number;
  }): Promise<{
    dataPoints: Array<{
      date: string;
      score: number;
      passing: number;
      failing: number;
      total: number;
    }>;
    controlChanges: {
      mostImproved: Array<{
        controlPath: string;
        controlName: string;
        startScore: number;
        endScore: number;
        changePercent: number;
        direction: 'improved' | 'declined' | 'stable';
      }>;
      mostDeclined: Array<{
        controlPath: string;
        controlName: string;
        startScore: number;
        endScore: number;
        changePercent: number;
        direction: 'improved' | 'declined' | 'stable';
      }>;
    };
  }> {
    const startTime = Date.now();
    const { assetIdentifier, startDate, endDate, maxDataPoints = 30 } = options;
    
    console.log(`[getComplianceTrendData] Starting: asset=${assetIdentifier || 'all'}, ${startDate} to ${endDate}`);
    
    try {
      // Calculate date range in days
      const start = new Date(startDate);
      const end = new Date(endDate);
      const totalDays = Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
      
      // Determine sampling interval to stay under maxDataPoints
      const sampleInterval = Math.max(1, Math.ceil(totalDays / maxDataPoints));
      
      console.log(`[getComplianceTrendData] Period: ${totalDays} days, sampling every ${sampleInterval} day(s)`);
      
      // Build cache key
      const cacheKey = `trends_${assetIdentifier || 'all'}_${startDate}_${endDate}_${sampleInterval}`;
      
      // Check cache first (trends can be cached longer - 10 minutes)
      const cachedData = await this.env.CACHE_KV?.get(cacheKey, 'json').catch(() => null);
      if (cachedData) {
        console.log(`[getComplianceTrendData] Cache hit in ${Date.now() - startTime}ms`);
        return cachedData as any;
      }
      
      // First, try the metrics/trends endpoint which has proper date range support
      // If that doesn't work, fall back to notes query
      const fetchStart = Date.now();
      
      // Try metrics endpoint for overall trend data
      try {
        const metricsUrl = `/metrics/trends/heatbar/control?start=${startDate}&end=${endDate}`;
        console.log(`[getComplianceTrendData] Trying metrics endpoint: ${metricsUrl}`);
        const metricsData = await this.fetch<any>(metricsUrl);
        
        if (metricsData && (Array.isArray(metricsData) ? metricsData.length > 0 : metricsData.data)) {
          console.log(`[getComplianceTrendData] Metrics endpoint returned data in ${Date.now() - fetchStart}ms`);
          // Process metrics data into our format
          const rawData = Array.isArray(metricsData) ? metricsData : (metricsData.data || []);
          
          // Aggregate by date
          const dailyAggregates = new Map<string, { passing: number; failing: number; total: number }>();
          
          for (const entry of rawData) {
            const dateKey = entry.date || entry.timestamp?.split('T')[0];
            if (!dateKey) continue;
            
            if (!dailyAggregates.has(dateKey)) {
              dailyAggregates.set(dateKey, { passing: 0, failing: 0, total: 0 });
            }
            const daily = dailyAggregates.get(dateKey)!;
            daily.passing += entry.passing || entry.pass || 0;
            daily.failing += entry.failing || entry.fail || 0;
            daily.total += (entry.passing || entry.pass || 0) + (entry.failing || entry.fail || 0);
          }
          
          // Convert to sorted data points
          const sortedDates = Array.from(dailyAggregates.keys()).sort();
          const dataPoints = [];
          
          const sampleInterval = Math.max(1, Math.ceil(sortedDates.length / maxDataPoints));
          for (let i = 0; i < sortedDates.length; i += sampleInterval) {
            const dateKey = sortedDates[i];
            const agg = dailyAggregates.get(dateKey)!;
            const score = agg.total > 0 ? (agg.passing / agg.total) * 100 : 0;
            
            dataPoints.push({
              date: dateKey,
              score: Math.round(score * 10) / 10,
              passing: agg.passing,
              failing: agg.failing,
              total: agg.total,
            });
            
            if (dataPoints.length >= maxDataPoints) break;
          }
          
          if (dataPoints.length > 0) {
            const result = {
              dataPoints,
              controlChanges: { mostImproved: [], mostDeclined: [] },
            };
            
            // Cache the result
            if (this.env.CACHE_KV) {
              await this.env.CACHE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 }).catch(() => {});
            }
            
            console.log(`[getComplianceTrendData] Metrics endpoint success: ${dataPoints.length} data points`);
            return result;
          }
        }
      } catch (metricsError) {
        console.log(`[getComplianceTrendData] Metrics endpoint failed, falling back to notes: ${metricsError}`);
      }
      
      // Fallback: Query attestations using notes endpoint with server-side time filtering
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'attestation');
      queryParams.set('limit', '1000');
      
      // Use server-side time filtering with from=/to= params
      // This significantly reduces data transfer compared to fetching all and filtering client-side
      queryParams.set('from', start.toISOString());
      queryParams.set('to', end.toISOString());
      
      const notesUrl = `/notes?${queryParams.toString()}`;
      console.log(`[getComplianceTrendData] Fallback to notes with server-side time filter: ${notesUrl}`);
      
      const notesData = await this.fetch<any>(notesUrl);
      const allNotes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      
      console.log(`[getComplianceTrendData] Fetched ${allNotes.length} notes (server-filtered) in ${Date.now() - fetchStart}ms`);
      
      // Log the actual date range of fetched data for verification
      if (allNotes.length > 0) {
        const dates = allNotes
          .map((n: any) => n.timestamp || n.origination)
          .filter(Boolean)
          .map((d: string) => new Date(d).getTime())
          .sort((a: number, b: number) => a - b);
        
        if (dates.length > 0) {
          const oldestDate = new Date(dates[0]).toISOString().split('T')[0];
          const newestDate = new Date(dates[dates.length - 1]).toISOString().split('T')[0];
          console.log(`[getComplianceTrendData] Data range: ${oldestDate} to ${newestDate} (requested: ${startDate} to ${endDate})`);
        }
      }
      
      // Notes are already filtered by time server-side, just need to filter by asset if specified
      let filteredNotes = allNotes;
      
      if (assetIdentifier) {
        const searchLower = assetIdentifier.toLowerCase();
        filteredNotes = filteredNotes.filter((note: any) => {
          const assetName = note.asset?.name || '';
          const assetUuid = note.asset?.uuid || '';
          return assetName.toLowerCase().includes(searchLower) ||
                 assetUuid.toLowerCase().includes(searchLower);
        });
        console.log(`[getComplianceTrendData] Filtered to ${filteredNotes.length} notes for asset: ${assetIdentifier}`);
      }
      
      // Aggregate by date
      const dailyAggregates = new Map<string, { passing: number; failing: number; total: number }>();
      const controlAggregates = new Map<string, { 
        controlPath: string;
        controlName: string;
        earlyPassing: number;
        earlyTotal: number;
        latePassing: number;
        lateTotal: number;
      }>();
      
      // Midpoint for early vs late comparison
      const midPoint = new Date((start.getTime() + end.getTime()) / 2);
      
      for (const note of filteredNotes) {
        const noteDate = new Date(note.timestamp || note.origination);
        const dateKey = noteDate.toISOString().split('T')[0];
        const result = note.result || (note.detail?.result) || 'unknown';
        const isPassing = result === 'pass' || result === 'passed';
        
        // Daily aggregate
        if (!dailyAggregates.has(dateKey)) {
          dailyAggregates.set(dateKey, { passing: 0, failing: 0, total: 0 });
        }
        const daily = dailyAggregates.get(dateKey)!;
        daily.total++;
        if (isPassing) {
          daily.passing++;
        } else {
          daily.failing++;
        }
        
        // Control-level aggregate
        const controlPath = note.path || note.control?.path || 'unknown';
        const controlName = note.control?.name || controlPath;
        
        if (!controlAggregates.has(controlPath)) {
          controlAggregates.set(controlPath, {
            controlPath,
            controlName,
            earlyPassing: 0,
            earlyTotal: 0,
            latePassing: 0,
            lateTotal: 0,
          });
        }
        const ctrl = controlAggregates.get(controlPath)!;
        
        if (noteDate < midPoint) {
          ctrl.earlyTotal++;
          if (isPassing) ctrl.earlyPassing++;
        } else {
          ctrl.lateTotal++;
          if (isPassing) ctrl.latePassing++;
        }
      }
      
      // Convert daily aggregates to sampled data points
      const sortedDates = Array.from(dailyAggregates.keys()).sort();
      const dataPoints: Array<{
        date: string;
        score: number;
        passing: number;
        failing: number;
        total: number;
      }> = [];
      
      for (let i = 0; i < sortedDates.length; i += sampleInterval) {
        const dateKey = sortedDates[i];
        const agg = dailyAggregates.get(dateKey)!;
        const score = agg.total > 0 ? (agg.passing / agg.total) * 100 : 0;
        
        dataPoints.push({
          date: dateKey,
          score: Math.round(score * 10) / 10,
          passing: agg.passing,
          failing: agg.failing,
          total: agg.total,
        });
        
        if (dataPoints.length >= maxDataPoints) break;
      }
      
      // Calculate control-level changes
      const controlChanges: Array<{
        controlPath: string;
        controlName: string;
        startScore: number;
        endScore: number;
        changePercent: number;
        direction: 'improved' | 'declined' | 'stable';
      }> = [];
      
      for (const [, ctrl] of controlAggregates) {
        if (ctrl.earlyTotal < 2 || ctrl.lateTotal < 2) continue; // Need enough data
        
        const earlyScore = (ctrl.earlyPassing / ctrl.earlyTotal) * 100;
        const lateScore = (ctrl.latePassing / ctrl.lateTotal) * 100;
        const changePercent = lateScore - earlyScore;
        
        let direction: 'improved' | 'declined' | 'stable';
        if (changePercent > 5) {
          direction = 'improved';
        } else if (changePercent < -5) {
          direction = 'declined';
        } else {
          direction = 'stable';
        }
        
        controlChanges.push({
          controlPath: ctrl.controlPath,
          controlName: ctrl.controlName,
          startScore: Math.round(earlyScore * 10) / 10,
          endScore: Math.round(lateScore * 10) / 10,
          changePercent: Math.round(changePercent * 10) / 10,
          direction,
        });
      }
      
      // Sort to find most improved and most declined
      const mostImproved = controlChanges
        .filter(c => c.direction === 'improved')
        .sort((a, b) => b.changePercent - a.changePercent)
        .slice(0, 5);
      
      const mostDeclined = controlChanges
        .filter(c => c.direction === 'declined')
        .sort((a, b) => a.changePercent - b.changePercent)
        .slice(0, 5);
      
      const result = {
        dataPoints,
        controlChanges: {
          mostImproved,
          mostDeclined,
        },
      };
      
      // Cache the result
      if (this.env.CACHE_KV) {
        await this.env.CACHE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 }).catch(() => {});
        console.log(`[getComplianceTrendData] Cached result (TTL: 600s)`);
      }
      
      console.log(`[getComplianceTrendData] Completed in ${Date.now() - startTime}ms: ${dataPoints.length} data points`);
      
      return result;
      
    } catch (error) {
      console.error(`[getComplianceTrendData] Failed after ${Date.now() - startTime}ms:`, error);
      
      // Return empty result on error
      return {
        dataPoints: [],
        controlChanges: {
          mostImproved: [],
          mostDeclined: [],
        },
      };
    }
  }

  /**
   * Fetch control definition with full details including OPA Rego policy
   * Uses /console/controls/{uuid} endpoint
   * Returns control definition with decoded Rego and policy data
   */
  async getControlWithRego(controlIdentifier: string): Promise<{
    found: boolean;
    control?: {
      uuid: string;
      name: string;
      path: string;
      displayKey?: string;
      description?: string;
    };
    rego?: {
      raw: string;
      decoded: string;
    };
    policyData?: {
      raw: string;
      decoded: any;
    };
    preprocessor?: {
      raw: string;
      decoded: string;
    };
    sampleInput?: {
      raw: string;
      decoded: any;
    };
    policyTemplate?: {
      measures: Array<{
        name: string;
        type: string;
        value: string;
        description?: string;
      }>;
    };
    error?: string;
  }> {
    console.log(`[getControlWithRego] Fetching control: ${controlIdentifier}`);
    
    try {
      // First, try to find the control by UUID or path
      let controlUuid = controlIdentifier;
      let controlData: any = null;
      
      // If it looks like a path (contains dots), search by path
      if (controlIdentifier.includes('.')) {
        console.log(`[getControlWithRego] Searching by path: ${controlIdentifier}`);
        const allControls = await this.fetch<any[]>('/console/controls');
        const matchingControl = allControls?.find(
          (c: any) => c.path === controlIdentifier || c.name === controlIdentifier
        );
        
        if (matchingControl) {
          controlUuid = matchingControl.uuid;
          controlData = matchingControl;
          console.log(`[getControlWithRego] Found control UUID: ${controlUuid}`);
        } else {
          console.log(`[getControlWithRego] Control not found by path`);
          return { found: false, error: `Control not found: ${controlIdentifier}` };
        }
      }
      
      // Fetch full control details
      if (!controlData) {
        controlData = await this.fetch<any>(`/console/controls/${controlUuid}`);
      }
      
      if (!controlData) {
        return { found: false, error: `Control not found: ${controlIdentifier}` };
      }
      
      console.log(`[getControlWithRego] Got control: ${controlData.name || controlData.path}`);
      
      const result: any = {
        found: true,
        control: {
          uuid: controlData.uuid,
          name: controlData.name,
          path: controlData.path,
          displayKey: controlData.detail?.control?.displayKey,
          description: controlData.detail?.control?.fullName || controlData.name,
        },
      };
      
      // Extract and decode evaluation components
      const evaluations = controlData.detail?.evaluation || [];
      
      for (const evalItem of evaluations) {
        const key = evalItem.key;
        const base64Content = evalItem.detail;
        
        if (!base64Content) continue;
        
        try {
          // Decode base64
          const decoded = atob(base64Content);
          
          switch (key) {
            case 'rule':
              result.rego = {
                raw: base64Content,
                decoded: decoded,
              };
              console.log(`[getControlWithRego] Decoded Rego policy (${decoded.length} chars)`);
              break;
              
            case 'data':
              try {
                const parsedData = JSON.parse(decoded);
                result.policyData = {
                  raw: base64Content,
                  decoded: parsedData,
                };
                console.log(`[getControlWithRego] Decoded policy data`);
              } catch {
                result.policyData = {
                  raw: base64Content,
                  decoded: decoded,
                };
              }
              break;
              
            case 'detail':
              result.preprocessor = {
                raw: base64Content,
                decoded: decoded,
              };
              console.log(`[getControlWithRego] Decoded preprocessor (${decoded.length} chars)`);
              break;
              
            case 'input':
              try {
                const parsedInput = JSON.parse(decoded);
                result.sampleInput = {
                  raw: base64Content,
                  decoded: parsedInput,
                };
              } catch {
                result.sampleInput = {
                  raw: base64Content,
                  decoded: decoded,
                };
              }
              break;
          }
        } catch (decodeError) {
          console.log(`[getControlWithRego] Failed to decode ${key}: ${decodeError}`);
        }
      }
      
      // Extract policy template (measures/thresholds)
      if (controlData.detail?.policyTemplate?.measures) {
        result.policyTemplate = {
          measures: controlData.detail.policyTemplate.measures.map((m: any) => ({
            name: m.name,
            type: m.type,
            value: m.value,
            description: m.description,
          })),
        };
      }
      
      return result;
      
    } catch (error: any) {
      console.error(`[getControlWithRego] Error:`, error);
      return { found: false, error: error.message || 'Failed to fetch control' };
    }
  }

  /**
   * Get a failing attestation with full details for analysis
   * Returns attestation info plus the control path needed to fetch Rego
   */
  async getFailingAttestationForAnalysis(
    assetIdentifier: string,
    controlPath?: string,
    options: { branch?: string; commit?: string } = {}
  ): Promise<{
    found: boolean;
    attestation?: {
      uuid: string;
      result: string;
      timestamp: string;
      controlPath: string;
      controlUuid?: string;
      controlName?: string;
      assetName: string;
      commit?: string;
      branch?: string;
      detail?: any;
      evaluation?: any;
      policy?: any;
    };
    error?: string;
  }> {
    const { branch, commit } = options;
    console.log(`[getFailingAttestationForAnalysis] Asset: ${assetIdentifier}, Control: ${controlPath || 'any'}, Branch: ${branch || 'default'}, Commit: ${commit || 'latest'}`);
    
    try {
      // Build query params
      const params = new URLSearchParams();
      params.set('kind', 'attestation');
      params.set('limit', '100');
      
      // Try to add asset filter
      if (assetIdentifier) {
        params.set('repository', assetIdentifier);
      }
      
      // Add branch filter if specified
      if (branch) {
        params.set('branch', branch);
      }
      
      const notesData = await this.fetch<any[]>(`/notes?${params.toString()}`);
      
      if (!Array.isArray(notesData) || notesData.length === 0) {
        return { found: false, error: 'No attestations found for this asset' };
      }
      
      // Filter by commit if specified
      let attestations = commit 
        ? notesData.filter((note: any) => 
            note.asset?.version?.commit?.startsWith(commit) ||
            note.asset?.scm?.repository?.commit?.startsWith(commit)
          )
        : notesData;
      
      if (commit && attestations.length === 0) {
        return { found: false, error: `No attestations found for commit: ${commit}` };
      }
      
      // Find failing attestations (or all if we want to see passing too for specific commit)
      let failingAttestations = attestations.filter((note: any) => 
        note.type === 'attestation' && 
        (note.result === 'fail' || note.status === 'fail')
      );
      
      // Filter by control path if specified
      if (controlPath) {
        failingAttestations = failingAttestations.filter((note: any) =>
          note.path === controlPath ||
          note.path?.includes(controlPath)
        );
      }
      
      // If looking for a specific commit, also check passing attestations if no failing found
      if (failingAttestations.length === 0 && commit) {
        // Try to find any attestation for this control at this commit
        let anyAttestations = attestations.filter((note: any) =>
          note.type === 'attestation' &&
          (note.path === controlPath || note.path?.includes(controlPath))
        );
        
        if (anyAttestations.length > 0) {
          // Return the most recent attestation even if passing
          failingAttestations = anyAttestations;
        }
      }
      
      if (failingAttestations.length === 0) {
        return { 
          found: false, 
          error: controlPath 
            ? `No attestations found for control: ${controlPath}${commit ? ` at commit ${commit}` : ''}` 
            : 'No attestations found'
        };
      }
      
      // Get the most recent failing attestation
      const attestation = failingAttestations.sort((a: any, b: any) => 
        new Date(b.timestamp || b.origination).getTime() - new Date(a.timestamp || a.origination).getTime()
      )[0];
      
      console.log(`[getFailingAttestationForAnalysis] Found failing attestation: ${attestation.uuid}`);
      
      // Try to get more details
      let fullAttestation = attestation;
      try {
        fullAttestation = await this.fetch<any>(`/notes/${attestation.uuid}`);
      } catch {
        // Use the basic attestation data
      }
      
      return {
        found: true,
        attestation: {
          uuid: fullAttestation.uuid,
          result: fullAttestation.result || fullAttestation.status,
          timestamp: fullAttestation.timestamp || fullAttestation.origination,
          controlPath: fullAttestation.path,
          controlUuid: fullAttestation.control?.uuid,
          controlName: fullAttestation.control?.name || fullAttestation.display?.controlName,
          assetName: fullAttestation.asset?.name || fullAttestation.asset?.parent?.name || assetIdentifier,
          commit: fullAttestation.asset?.version?.commit || fullAttestation.asset?.scm?.repository?.commit,
          branch: fullAttestation.asset?.scm?.repository?.branch || fullAttestation.asset?.version?.branch,
          detail: fullAttestation.detail,
          evaluation: fullAttestation.evaluation,
          policy: fullAttestation.policy,
        },
      };
      
    } catch (error: any) {
      console.error(`[getFailingAttestationForAnalysis] Error:`, error);
      return { found: false, error: error.message || 'Failed to fetch attestation' };
    }
  }

  /**
   * Get commit author statistics from commit history attestations
   * 
   * Uses ci.commithistory.codereview attestations which contain full author info:
   * - author.name, author.email, author.login
   * - commit sha, message, timestamp
   * - pull request info and reviews
   * 
   * @param options - Query options
   * @returns Commit author statistics
   */
  async getCommitAuthorStats(options: {
    assetIdentifier?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  } = {}): Promise<{
    authors: Array<{
      name: string;
      email: string;
      login?: string;
      commitCount: number;
      prCount: number;
      reviewCount: number;
      latestCommit?: string;
    }>;
    totalCommits: number;
    totalPRs: number;
    dateRange: { from: string; to: string };
    assets: string[];
  }> {
    const { assetIdentifier, startDate, endDate, limit = 500 } = options;
    const startTime = Date.now();
    
    console.log(`[getCommitAuthorStats] Starting: asset=${assetIdentifier || 'all'}, range=${startDate || 'all'} to ${endDate || 'now'}`);
    
    try {
      // Build query for commit history attestations
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'attestation');
      queryParams.set('path', 'ci.commithistory.codereview');
      queryParams.set('limit', String(limit));
      
      // Use server-side time filtering
      if (startDate) {
        queryParams.set('from', new Date(startDate).toISOString());
      }
      if (endDate) {
        queryParams.set('to', new Date(endDate).toISOString());
      }
      
      const notesUrl = `/notes?${queryParams.toString()}`;
      console.log(`[getCommitAuthorStats] Fetching: ${notesUrl}`);
      
      const notesData = await this.fetch<any>(notesUrl);
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      
      console.log(`[getCommitAuthorStats] Fetched ${notes.length} commit history attestations in ${Date.now() - startTime}ms`);
      
      // Filter by asset if specified
      let filteredNotes = notes;
      if (assetIdentifier) {
        const searchLower = assetIdentifier.toLowerCase();
        filteredNotes = notes.filter((note: any) => {
          const assetName = note.asset?.name || '';
          const assetUuid = note.asset?.uuid || '';
          return assetName.toLowerCase().includes(searchLower) ||
                 assetUuid.toLowerCase().includes(searchLower);
        });
        console.log(`[getCommitAuthorStats] Filtered to ${filteredNotes.length} notes for asset: ${assetIdentifier}`);
      }
      
      // Aggregate author statistics
      const authorMap = new Map<string, {
        name: string;
        email: string;
        login?: string;
        commitCount: number;
        prCount: number;
        reviewCount: number;
        latestCommit?: string;
        latestDate?: Date;
      }>();
      
      const assets = new Set<string>();
      let totalCommits = 0;
      let totalPRs = 0;
      let minDate: Date | null = null;
      let maxDate: Date | null = null;
      
      for (const note of filteredNotes) {
        const detail = note.detail;
        if (!detail?.commits) continue;
        
        // Track asset
        if (note.asset?.name) {
          assets.add(note.asset.name);
        }
        
        // Process commits
        for (const commit of detail.commits) {
          const author = commit.author;
          if (!author?.email) continue;
          
          totalCommits++;
          
          // Track date range
          const commitDate = author.date ? new Date(author.date) : null;
          if (commitDate) {
            if (!minDate || commitDate < minDate) minDate = commitDate;
            if (!maxDate || commitDate > maxDate) maxDate = commitDate;
          }
          
          // Use email as unique key
          const key = author.email.toLowerCase();
          
          if (!authorMap.has(key)) {
            authorMap.set(key, {
              name: author.name || 'Unknown',
              email: author.email,
              login: author.login,
              commitCount: 0,
              prCount: 0,
              reviewCount: 0,
            });
          }
          
          const stats = authorMap.get(key)!;
          stats.commitCount++;
          
          // Update latest commit
          if (commitDate && (!stats.latestDate || commitDate > stats.latestDate)) {
            stats.latestDate = commitDate;
            stats.latestCommit = commit.sha?.substring(0, 7);
          }
          
          // Count PRs created by this author
          if (commit.pulls) {
            for (const pr of commit.pulls) {
              if (pr.merged) {
                totalPRs++;
                // Check if this author merged the PR
                if (pr.merged_by?.toLowerCase() === author.login?.toLowerCase() ||
                    pr.merged_by?.toLowerCase() === author.name?.toLowerCase()) {
                  stats.prCount++;
                }
              }
              
              // Count reviews by this author
              if (pr.reviews) {
                for (const review of pr.reviews) {
                  if (review.user?.toLowerCase() === author.login?.toLowerCase()) {
                    stats.reviewCount++;
                  }
                }
              }
            }
          }
        }
      }
      
      // Convert to sorted array (by commit count desc)
      const authors = Array.from(authorMap.values())
        .map(a => ({
          name: a.name,
          email: a.email,
          login: a.login,
          commitCount: a.commitCount,
          prCount: a.prCount,
          reviewCount: a.reviewCount,
          latestCommit: a.latestCommit,
        }))
        .sort((a, b) => b.commitCount - a.commitCount);
      
      console.log(`[getCommitAuthorStats] Found ${authors.length} unique authors, ${totalCommits} commits in ${Date.now() - startTime}ms`);
      
      return {
        authors,
        totalCommits,
        totalPRs,
        dateRange: {
          from: minDate?.toISOString().split('T')[0] || startDate || 'unknown',
          to: maxDate?.toISOString().split('T')[0] || endDate || 'unknown',
        },
        assets: Array.from(assets),
      };
      
    } catch (error: any) {
      console.error(`[getCommitAuthorStats] Error:`, error);
      throw error;
    }
  }

  /**
   * Get the latest commit history attestation for a specific asset.
   * This is a fast point-in-time lookup (not a time-series aggregation).
   */
  async getLatestCommitHistory(options: {
    assetIdentifier: string;
    branch?: string;
    commit?: string;
  }): Promise<any | null> {
    const { assetIdentifier, branch, commit } = options;
    console.log(`[getLatestCommitHistory] Looking up: asset=${assetIdentifier}, branch=${branch || 'any'}, commit=${commit || 'latest'}`);
    
    try {
      // First resolve the asset to get UUID
      const resolved = await this.resolveAssetContext(assetIdentifier);
      
      // Build query - get the most recent commit history attestation
      const queryParams = new URLSearchParams();
      queryParams.set('type', 'attestation');
      queryParams.set('path', 'ci.commithistory.codereview');
      queryParams.set('limit', '5'); // Get a few to find the right one
      
      if (resolved.assetUuid) {
        queryParams.set('assetId', resolved.assetUuid);
      }
      
      const notesUrl = `/notes?${queryParams.toString()}`;
      console.log(`[getLatestCommitHistory] Fetching: ${notesUrl}`);
      
      const notesData = await this.fetch<any>(notesUrl);
      const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
      
      console.log(`[getLatestCommitHistory] Found ${notes.length} commit history attestations`);
      
      if (notes.length === 0) {
        // Fallback: try searching by asset name in detail
        console.log(`[getLatestCommitHistory] No results by assetId, trying broader search`);
        const fallbackParams = new URLSearchParams();
        fallbackParams.set('type', 'attestation');
        fallbackParams.set('path', 'ci.commithistory.codereview');
        fallbackParams.set('limit', '20');
        
        const fallbackUrl = `/notes?${fallbackParams.toString()}`;
        const fallbackData = await this.fetch<any>(fallbackUrl);
        const fallbackNotes = Array.isArray(fallbackData) ? fallbackData : (fallbackData.notes || fallbackData.data || []);
        
        // Filter by asset name
        const searchLower = assetIdentifier.toLowerCase();
        const matchingNotes = fallbackNotes.filter((n: any) => {
          const assetName = n.asset?.name?.toLowerCase() || '';
          return assetName.includes(searchLower) || searchLower.includes(assetName);
        });
        
        if (matchingNotes.length === 0) {
          return null;
        }
        
        notes.push(...matchingNotes);
      }
      
      // Filter by branch/commit if specified
      let filtered = notes;
      
      if (branch) {
        filtered = filtered.filter((n: any) => {
          const noteBranch = n.detail?.branch || n.detail?.ref || '';
          return noteBranch.toLowerCase().includes(branch.toLowerCase());
        });
      }
      
      if (commit) {
        filtered = filtered.filter((n: any) => {
          const headSha = n.detail?.headCommit?.sha || '';
          const commits = n.detail?.commits || [];
          return headSha.startsWith(commit) || 
                 commits.some((c: any) => c.sha?.startsWith(commit));
        });
      }
      
      // Return the most recent one
      if (filtered.length > 0) {
        return filtered[0];
      }
      
      // If filtering narrowed to zero, return the first unfiltered
      return notes[0] || null;
      
    } catch (error: any) {
      console.error(`[getLatestCommitHistory] Error:`, error);
      throw error;
    }
  }
}

