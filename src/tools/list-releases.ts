/**
 * List Releases Tool
 * 
 * Lists releases for an application with filtering by status and time.
 * 
 * KEY BEHAVIOR:
 * - Uses includesChild API parameter to find releases that include the app or any of its repos
 * - This matches the Fianu UI behavior: shows releases that contain any of an app's repos
 * - Supports app codes (e.g., "0915634599") and app names (e.g., "Davis Group")
 * 
 * SCALABILITY NOTES:
 * - Server-side filtering via includesChild parameter
 * - Results are capped at 50 to prevent timeout issues
 * - For large orgs, always filter by application AND status/time
 * 
 * IMPORTANT: MCP tool schemas MUST use plain JSON Schema objects, NOT Zod.
 */
import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * Release information returned by the tool
 */
interface ReleaseInfo {
  uuid: string;
  name: string;
  status: 'pending' | 'released' | string;
  version?: string;
  releaseId?: string;
  applicationName?: string;
  applicationCode?: string;
  targetEnvironment?: string;
  targetGate?: string;
  createdAt?: string;
  modifiedAt?: string;
}

/**
 * Response from list_releases tool
 */
interface ListReleasesResponse {
  releases: ReleaseInfo[];
  count: number;
  totalMatched: number;
  truncated: boolean;
  query: {
    applicationName: string;
    resolvedTo?: string;  // Shows the resolved app name if different from input
    status?: string;
    limit?: number;
    since?: string;
  };
  insights: string[];
  limitations: string[];
}

/**
 * JSON Schema for the list_releases tool
 */
export const listReleasesSchema = {
  type: 'object',
  properties: {
    applicationName: {
      type: 'string',
      description: 'REQUIRED: Application name or code to filter releases (e.g., "DBX", "Digital Banking Experience"). Releases are application-level, not repository-level.',
    },
    status: {
      type: 'string',
      enum: ['pending', 'released', 'all'],
      description: 'Filter by release status. "pending" = upcoming/scheduled releases, "released" = completed releases, "all" = both. Default: "all"',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of releases to return (1-50). Default: 10. For "pending" status, usually returns fewer since there are typically only a few pending releases.',
    },
    since: {
      type: 'string',
      description: 'Only return releases created/modified since this date. ISO 8601 format (e.g., "2024-12-01") or relative like "7d" (7 days), "30d" (30 days). Max: 30 days back. Only applies to "released" status.',
    },
  },
  required: ['applicationName'],
};

// Constants for limits
const MAX_RESULTS = 50;
const DEFAULT_LIMIT = 10;
const MAX_DAYS_BACK = 30;

/**
 * Parse a "since" parameter into a Date
 */
function parseSinceDate(since: string): Date | null {
  // Check for relative format like "7d", "30d"
  const relativeMatch = since.match(/^(\d+)d$/);
  if (relativeMatch) {
    const days = parseInt(relativeMatch[1], 10);
    if (days > MAX_DAYS_BACK) {
      return null; // Exceeds max
    }
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }
  
  // Try ISO date format
  const parsed = new Date(since);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  
  // Check if it's within MAX_DAYS_BACK
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() - MAX_DAYS_BACK);
  if (parsed < maxDate) {
    return null; // Too far back
  }
  
  return parsed;
}

/**
 * Handler for the list_releases tool
 * 
 * Lists releases for an application with optional filtering.
 * 
 * Use cases:
 * - "What are the upcoming releases for DBX?"
 * - "Show me the last 5 releases for Digital Banking Experience"
 * - "What releases happened in the last week for DBX?"
 */
export const listReleasesHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<ListReleasesResponse> => {
  const client = new ConsultaClient(env, session);
  const startTime = Date.now();
  
  const applicationName = args.applicationName as string;
  const status = (args.status as string) || 'all';
  const requestedLimit = Math.min(Math.max(1, (args.limit as number) || DEFAULT_LIMIT), MAX_RESULTS);
  const since = args.since as string | undefined;
  
  // Validate required parameter
  if (!applicationName) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'applicationName is required',
          message: 'Please provide the application name or code (e.g., "DBX" or "Digital Banking Experience"). Releases are associated with applications, not individual repositories.',
        }, null, 2)
      }],
    } as any;
  }
  
  console.log(`[list_releases] Starting: app=${applicationName}, status=${status}, limit=${requestedLimit}, since=${since}`);
  
  const insights: string[] = [];
  const limitations: string[] = [
    'Releases are application-level assets, not repository-level',
    `Results capped at ${MAX_RESULTS} releases`,
    `Time-based filtering limited to last ${MAX_DAYS_BACK} days`,
    'Uses includesChild parameter to find releases that include the app or any of its repos',
  ];
  
  try {
    // Parse since date if provided
    let sinceDate: Date | null = null;
    if (since) {
      sinceDate = parseSinceDate(since);
      if (!sinceDate) {
        insights.push(`⚠️ Could not parse "since" parameter "${since}" or it exceeds ${MAX_DAYS_BACK} day limit - ignoring time filter`);
      } else {
        insights.push(`Filtering releases since ${sinceDate.toISOString().split('T')[0]}`);
      }
    }
    
    // Fetch releases from API using includesChild parameter
    // This finds releases that include the app or any of its child repos
    const releaseResult = await client.listReleases({
      applicationName,
      status: status === 'all' ? undefined : status as 'pending' | 'released',
      limit: requestedLimit * 2, // Fetch extra in case status filter removes some
    });
    
    if (!releaseResult.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Failed to fetch releases',
            message: releaseResult.error || 'Unknown error',
            query: { applicationName, status },
          }, null, 2)
        }],
      } as any;
    }
    
    let releases = releaseResult.releases;
    const resolvedAppName = releaseResult.filtered?.resolvedApp;
    const resolvedAppUuid = releaseResult.filtered?.resolvedUuid;
    const childUuidsUsed = (releaseResult.filtered as any)?.childUuidsUsed as string[] | undefined;
    console.log(`[list_releases] Found ${releases.length} releases containing app/repos`);
    
    // Add insight about app resolution if different from input
    if (resolvedAppName && resolvedAppName.toLowerCase() !== applicationName.toLowerCase()) {
      insights.push(`🔍 Resolved "${applicationName}" → "${resolvedAppName}"`);
    }
    
    // Show which UUID strategy was used
    if (childUuidsUsed && childUuidsUsed.length > 0) {
      insights.push(`🔗 Searching for releases containing app's repos (using child asset UUIDs)`);
    } else if (resolvedAppUuid) {
      insights.push(`🔗 Searching for releases containing app UUID: ${resolvedAppUuid}`);
    }
    
    // Apply time filter if specified (only for released, not pending)
    if (sinceDate && status !== 'pending') {
      const beforeCount = releases.length;
      releases = releases.filter(r => {
        const releaseDate = r.modifiedAt ? new Date(r.modifiedAt) : (r.createdAt ? new Date(r.createdAt) : null);
        if (!releaseDate) return true; // Include if no date info
        return releaseDate >= sinceDate!;
      });
      console.log(`[list_releases] After time filter: ${releases.length} releases (was ${beforeCount})`);
      
      if (releases.length < beforeCount) {
        insights.push(`Filtered from ${beforeCount} to ${releases.length} releases based on time`);
      }
    }
    
    // Sort: pending first (by name), then released by date (newest first)
    releases.sort((a, b) => {
      // Pending releases first
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      
      // Then by date (newest first)
      const dateA = a.modifiedAt || a.createdAt || '';
      const dateB = b.modifiedAt || b.createdAt || '';
      return dateB.localeCompare(dateA);
    });
    
    // Track total before truncating
    const totalMatched = releases.length;
    const truncated = releases.length > requestedLimit;
    
    // Apply limit
    releases = releases.slice(0, requestedLimit);
    
    // Generate insights
    const pendingCount = releases.filter(r => r.status === 'pending').length;
    const releasedCount = releases.filter(r => r.status === 'released').length;
    
    if (pendingCount > 0) {
      insights.push(`📋 ${pendingCount} pending/upcoming release(s)`);
    }
    if (releasedCount > 0) {
      insights.push(`✅ ${releasedCount} completed release(s)`);
    }
    if (truncated) {
      insights.push(`⚠️ Results truncated: showing ${releases.length} of ${totalMatched} matching releases`);
    }
    if (releases.length === 0) {
      const displayName = resolvedAppName || applicationName;
      insights.push(`No releases found for "${displayName}" matching the specified filters`);
    }
    
    // Map to response format
    const releaseInfos: ReleaseInfo[] = releases.map(r => ({
      uuid: r.uuid,
      name: r.name,
      status: r.status,
      version: r.version,
      releaseId: r.releaseId,
      applicationName: r.parentName || r.subtitle,
      targetEnvironment: r.targetEnvironment,
      targetGate: r.targetGate,
      createdAt: r.createdAt,
      modifiedAt: r.modifiedAt,
    }));
    
    const response: ListReleasesResponse = {
      releases: releaseInfos,
      count: releaseInfos.length,
      totalMatched,
      truncated,
      query: {
        applicationName,
        resolvedTo: resolvedAppName !== applicationName ? resolvedAppName : undefined,
        status,
        limit: requestedLimit,
        since,
      },
      insights,
      limitations,
    };
    
    console.log(`[list_releases] Completed in ${Date.now() - startTime}ms: ${releaseInfos.length} releases returned`);
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    } as any;
    
  } catch (error) {
    console.error(`[list_releases] Failed after ${Date.now() - startTime}ms:`, error);
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Failed to list releases',
          message: error instanceof Error ? error.message : 'Unknown error',
          query: { applicationName, status },
        }, null, 2)
      }],
    } as any;
  }
};

