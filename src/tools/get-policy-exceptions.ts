/**
 * Policy Exceptions Tool
 * 
 * IMPORTANT: MCP tool schemas MUST use plain JSON Schema objects, NOT Zod.
 * Zod schemas will fail to serialize and break tool registration.
 * See README.md "Adding New Tools" section for the correct pattern.
 */

import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * A policy exception record
 */
interface PolicyException {
  uuid: string;
  name: string;
  path: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  daysUntilExpiration: number | null;
  control: {
    name: string;
    path: string;
  };
  justification: {
    role: string;
    message: string;
  };
  assetTypes: string[];
  criteria: string | null;
}

/**
 * Response from get_policy_exceptions tool
 */
interface PolicyExceptionsResponse {
  summary: {
    totalExceptions: number;
    activeExceptions: number;
    expiringSoon: number;  // Expiring in 30 days
    byControl: Record<string, number>;
  };
  exceptions: PolicyException[];
  query: {
    controlPath?: string;
    status?: string;
    since?: string;
  };
  insights: string[];
  limitations: string[];
}

/**
 * Tool schema for get_policy_exceptions
 */
export const getPolicyExceptionsSchema = {
  type: 'object',
  properties: {
    controlPath: {
      type: 'string',
      description: 'Filter to exceptions for a specific control (e.g., "ci.dependabot.alerts")',
    },
    status: {
      type: 'string',
      enum: ['active', 'inactive', 'all'],
      description: 'Filter by exception status (default: "active")',
    },
    expiringSoon: {
      type: 'boolean',
      description: 'If true, only show exceptions expiring in the next 30 days',
    },
  },
};

/**
 * Handler for get_policy_exceptions tool
 * 
 * Lists policy exceptions with filtering and grouping capabilities.
 * 
 * IMPORTANT LIMITATION: The API does not expose who requested/created exceptions.
 * Only the justification role (e.g., "internal:system:admin") and message are available.
 */
export const getPolicyExceptionsHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<any> => {
  const client = new ConsultaClient(env, session);
  
  const controlPath = args.controlPath as string | undefined;
  const statusFilter = (args.status as string) || 'active';
  const expiringSoonOnly = args.expiringSoon === true;
  
  console.log(`[get_policy_exceptions] Fetching exceptions (control=${controlPath}, status=${statusFilter})`);
  
  try {
    // Fetch all exceptions
    const result = await client.listPolicyExceptions({ limit: 100 });
    
    if (!result.success || !Array.isArray(result.data)) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'Failed to fetch policy exceptions',
            message: result.error || 'Unknown error',
          }, null, 2)
        }],
      };
    }
    
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    // Process and filter exceptions
    let exceptions: PolicyException[] = result.data.map((exc: any) => {
      const expiresAt = exc.expiration?.timestamp || null;
      let daysUntilExpiration: number | null = null;
      
      if (expiresAt) {
        const expDate = new Date(expiresAt);
        daysUntilExpiration = Math.ceil((expDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      }
      
      // Extract criteria summary (first expression display if available)
      let criteriaSummary: string | null = null;
      if (exc.policy?.[0]?.criteria?.expressions?.[0]?.exprDisplay) {
        criteriaSummary = exc.policy[0].criteria.expressions[0].exprDisplay;
      }
      
      return {
        uuid: exc.general?.entityId || '',
        name: exc.general?.policy?.name || 'Unnamed Exception',
        path: exc.general?.policy?.path || '',
        status: exc.general?.status || 'unknown',
        createdAt: exc.general?.timestamp || '',
        expiresAt,
        daysUntilExpiration,
        control: {
          name: exc.control?.name || 'Unknown',
          path: exc.control?.path || '',
        },
        justification: {
          role: exc.justification?.role || 'unknown',
          message: exc.justification?.message || '',
        },
        assetTypes: (exc.assets || []).map((a: any) => a.name || a.path || 'unknown'),
        criteria: criteriaSummary,
      };
    });
    
    // Apply filters
    if (statusFilter !== 'all') {
      exceptions = exceptions.filter(e => e.status === statusFilter);
    }
    
    if (controlPath) {
      exceptions = exceptions.filter(e => 
        e.control.path.toLowerCase().includes(controlPath.toLowerCase()) ||
        e.control.name.toLowerCase().includes(controlPath.toLowerCase())
      );
    }
    
    if (expiringSoonOnly) {
      exceptions = exceptions.filter(e => 
        e.expiresAt && new Date(e.expiresAt) <= thirtyDaysFromNow
      );
    }
    
    // Calculate summary stats
    const activeExceptions = exceptions.filter(e => e.status === 'active');
    const expiringSoon = exceptions.filter(e => 
      e.daysUntilExpiration !== null && e.daysUntilExpiration >= 0 && e.daysUntilExpiration <= 30
    );
    
    // Group by control
    const byControl: Record<string, number> = {};
    for (const exc of exceptions) {
      const controlKey = exc.control.path || exc.control.name;
      byControl[controlKey] = (byControl[controlKey] || 0) + 1;
    }
    
    // Generate insights
    const insights: string[] = [];
    
    if (exceptions.length === 0) {
      insights.push('No exceptions found matching the specified criteria.');
    } else {
      insights.push(`Found ${exceptions.length} exception(s) matching criteria.`);
      
      if (activeExceptions.length > 0) {
        insights.push(`${activeExceptions.length} active exception(s).`);
      }
      
      if (expiringSoon.length > 0) {
        insights.push(`⚠️ ${expiringSoon.length} exception(s) expiring within 30 days.`);
      }
      
      // Top controls with exceptions
      const sortedControls = Object.entries(byControl).sort((a, b) => b[1] - a[1]);
      if (sortedControls.length > 0) {
        const topControl = sortedControls[0];
        insights.push(`Most excepted control: "${topControl[0]}" with ${topControl[1]} exception(s).`);
      }
    }
    
    const response: PolicyExceptionsResponse = {
      summary: {
        totalExceptions: exceptions.length,
        activeExceptions: activeExceptions.length,
        expiringSoon: expiringSoon.length,
        byControl,
      },
      exceptions: exceptions.slice(0, 50), // Limit to 50 for response size
      query: {
        controlPath,
        status: statusFilter,
      },
      insights,
      limitations: [
        'IMPORTANT: The API does not expose who requested or created exceptions.',
        'Only the approver role (e.g., "internal:system:admin") is available, not individual user identity.',
        'To track individual requesters, this would require a backend enhancement.',
        'Business line / org unit filtering is not available in the current API.',
      ],
    };
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    };
    
  } catch (error) {
    console.error('[get_policy_exceptions] Error:', error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Failed to fetch policy exceptions',
          message: error instanceof Error ? error.message : 'Unknown error',
        }, null, 2)
      }],
    };
  }
};

