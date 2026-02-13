import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * Temporary exploration tool to discover policy exceptions API structure
 * Also checks for requester info in individual exception and audit endpoints
 * Now also explores asset search capabilities for deep linking
 */
export const exploreExceptionsHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<any> => {
  const client = new ConsultaClient(env, session);
  
  console.log('[explore_exceptions] Starting deep exploration...');
  
  const results: any = {
    listExceptions: null,
    singleException: null,
    auditTrail: null,
    requesterInfoFound: false,
    fieldsWithUserInfo: [],
  };
  
  try {
    // Step 1: List exceptions
    console.log('[explore_exceptions] Step 1: Listing exceptions...');
    const listResult = await client.listPolicyExceptions({ limit: 10 });
    results.listExceptions = {
      success: listResult.success,
      count: listResult.count,
      sampleKeys: listResult.data?.[0] ? Object.keys(listResult.data[0]) : [],
    };
    
    // Step 2: Try to get a single exception with more detail
    if (listResult.success && listResult.data?.[0]?.general?.entityId) {
      const entityId = listResult.data[0].general.entityId;
      console.log(`[explore_exceptions] Step 2: Fetching single exception ${entityId}...`);
      
      const singleResult = await client.getPolicyException(entityId);
      results.singleException = singleResult;
      
      // Check if single exception has more fields (like requester)
      if (singleResult.success && singleResult.data) {
        const singleData = singleResult.data;
        const checkForUserFields = (obj: any, path: string = '') => {
          if (!obj || typeof obj !== 'object') return;
          for (const key of Object.keys(obj)) {
            const fullPath = path ? `${path}.${key}` : key;
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('user') || lowerKey.includes('requester') || 
                lowerKey.includes('created_by') || lowerKey.includes('requestor') ||
                lowerKey.includes('author') || lowerKey.includes('submitter') ||
                lowerKey.includes('email') || lowerKey.includes('owner')) {
              results.fieldsWithUserInfo.push({ path: fullPath, value: obj[key] });
              results.requesterInfoFound = true;
            }
            if (typeof obj[key] === 'object' && obj[key] !== null) {
              checkForUserFields(obj[key], fullPath);
            }
          }
        };
        checkForUserFields(singleData);
      }
      
      // Step 3: Try to get audit trail
      console.log(`[explore_exceptions] Step 3: Checking audit trail for ${entityId}...`);
      const auditResult = await client.getExceptionAudit(entityId);
      results.auditTrail = auditResult;
      
      // Check audit for user info
      if (auditResult.success && auditResult.data) {
        const checkForUserFields = (obj: any, path: string = '') => {
          if (!obj || typeof obj !== 'object') return;
          for (const key of Object.keys(obj)) {
            const fullPath = path ? `${path}.${key}` : key;
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('user') || lowerKey.includes('requester') || 
                lowerKey.includes('created_by') || lowerKey.includes('requestor') ||
                lowerKey.includes('author') || lowerKey.includes('submitter') ||
                lowerKey.includes('email') || lowerKey.includes('owner')) {
              results.fieldsWithUserInfo.push({ path: `audit.${fullPath}`, value: obj[key] });
              results.requesterInfoFound = true;
            }
            if (typeof obj[key] === 'object' && obj[key] !== null) {
              checkForUserFields(obj[key], fullPath);
            }
          }
        };
        checkForUserFields(auditResult.data);
      }
    }
    
    // Also include one full exception record for reference
    if (listResult.data?.[0]) {
      results.sampleException = listResult.data[0];
    }
    
    // Step 4: Explore asset search capabilities (for deep linking feature)
    console.log('[explore_exceptions] Step 4: Exploring asset search capabilities...');
    try {
      const assetSearchResult = await client.exploreAssetSearch({
        repository: 'fianu-fullstack-demo',
      });
      results.assetSearch = assetSearchResult;
    } catch (err: any) {
      results.assetSearch = { error: err.message };
    }
    
    // Step 5: Explore release endpoints
    console.log('[explore_exceptions] Step 5: Exploring release endpoints...');
    results.releaseEndpoints = [];
    
    // Try direct UUID from the UI screenshot
    const testAssetUuid = '16854eb0-dbd7-4827-a15e-4ef175706a56';
    
    const releaseEndpointsToTry = [
      // Based on UI observation
      `/releases?asset=${testAssetUuid}`,
      `/console/releases?asset=${testAssetUuid}`,
      // Generic endpoints
      '/releases',
      '/releases?limit=5',
      '/console/releases',
      '/console/releases?limit=5', 
      '/assets?type=release',
      '/assets?type=release&limit=5',
      '/evidence/releases',
      // Try looking at the specific asset
      `/assets/${testAssetUuid}`,
      `/assets/${testAssetUuid}/releases`,
      // Try catalog endpoints  
      '/catalog/releases',
    ];
    
    for (const endpoint of releaseEndpointsToTry) {
      try {
        console.log(`[explore_exceptions] Trying release endpoint: ${endpoint}`);
        const response = await client.fetch<any>(endpoint);
        const releases = Array.isArray(response) ? response : 
                        (response?.releases || response?.data || response?.items || []);
        results.releaseEndpoints.push({
          endpoint,
          success: true,
          isArray: Array.isArray(response),
          count: Array.isArray(releases) ? releases.length : 'N/A',
          responseKeys: response && typeof response === 'object' && !Array.isArray(response) 
            ? Object.keys(response) : null,
          sampleKeys: Array.isArray(releases) && releases.length > 0 
            ? Object.keys(releases[0]) : null,
          sample: Array.isArray(releases) && releases.length > 0 
            ? releases[0] : null,
        });
        // If we found releases, break early
        if (Array.isArray(releases) && releases.length > 0) {
          console.log(`[explore_exceptions] Found ${releases.length} releases at ${endpoint}!`);
          break;
        }
      } catch (err: any) {
        results.releaseEndpoints.push({
          endpoint,
          success: false,
          error: err.message,
        });
      }
    }
    
    // Step 6: Explore control details for Rego policy
    console.log('[explore_exceptions] Step 6: Exploring control details for Rego...');
    try {
      // Fetch a single control to see full structure including Rego
      const controlsResponse = await client.fetch<any[]>('/console/controls?limit=1');
      if (controlsResponse && controlsResponse.length > 0) {
        const sampleControl = controlsResponse[0];
        results.controlDetails = {
          keys: Object.keys(sampleControl),
          sample: sampleControl,
        };
        
        // Check for Rego in various fields
        const regoFields = ['rego', 'policy', 'rule', 'code', 'definition', 'script'];
        for (const field of regoFields) {
          if (sampleControl[field]) {
            results.controlDetails.regoFieldFound = field;
            // If base64, try to decode
            if (typeof sampleControl[field] === 'string' && sampleControl[field].length > 50) {
              try {
                const decoded = atob(sampleControl[field]);
                results.controlDetails.decodedRego = decoded.slice(0, 500) + (decoded.length > 500 ? '...' : '');
              } catch (e) {
                results.controlDetails.regoRaw = sampleControl[field].slice(0, 200);
              }
            }
            break;
          }
        }
        
        // Also try fetching single control by UUID for more detail
        if (sampleControl.uuid) {
          try {
            const detailedControl = await client.fetch<any>(`/console/controls/${sampleControl.uuid}`);
            results.controlDetails.detailedKeys = Object.keys(detailedControl);
            results.controlDetails.detailed = detailedControl;
          } catch (e: any) {
            results.controlDetails.detailedError = e.message;
          }
        }
      }
    } catch (err: any) {
      results.controlDetails = { error: err.message };
    }
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(results, null, 2)
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Exploration failed',
          message: error instanceof Error ? error.message : 'Unknown error',
          partialResults: results,
        }, null, 2)
      }],
    };
  }
};

