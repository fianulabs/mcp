import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';

/**
 * Schema for get_evidence_chain tool parameters
 */
export const GetEvidenceChainSchema = z.object({
  noteUuid: z.string().optional().describe('UUID of a specific note (attestation, occurrence, or transaction) to trace'),
  assetIdentifier: z.string().optional().describe('Asset name or UUID - can be used alone (defaults to latest commit on default branch)'),
  commit: z.string().optional().describe('Commit SHA - use with assetIdentifier to find notes for a specific commit'),
  branch: z.string().optional().describe('Branch name (e.g., "main") - use with assetIdentifier to get latest commit on that branch'),
  controlPath: z.string().optional().describe('Control path to filter attestations (e.g., "cycode.secret.detection") - finds attestations matching this path'),
  direction: z.enum(['upstream', 'downstream', 'full']).optional().default('upstream').describe('Direction to trace: upstream (to origin), downstream (to children), or full (both)'),
  maxDepth: z.number().optional().default(10).describe('Maximum depth for downstream traversal'),
});

export type GetEvidenceChainParams = z.infer<typeof GetEvidenceChainSchema>;

/**
 * Represents a node in the evidence chain
 */
interface ChainNode {
  uuid: string;
  type: 'origin' | 'occurrence' | 'attestation' | 'transaction';
  path: string;
  result?: string;
  controlName?: string;
  controlPath?: string;
  timestamp?: string;
  parentUuid?: string;
  children?: ChainNode[];
  provenance?: Array<{
    source: string;
    integration: string;
    url: string;
  }>;
}

/**
 * Get evidence chain for a note, showing lineage from origin to attestations to deployments.
 * 
 * This tool traces the full evidence chain showing:
 * - Origin: The triggering event (e.g., GitHub workflow)
 * - Occurrences: Data collection events (builds, scans)
 * - Attestations: Control evaluations (pass/fail)
 * - Transactions: Deployment decisions
 * 
 * Use cases:
 * - "Show me the evidence chain for this attestation"
 * - "What led to this deployment decision?"
 * - "Trace the lineage from commit to attestation"
 */
export async function getEvidenceChain(
  consulta: ConsultaClient,
  params: GetEvidenceChainParams
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { noteUuid, assetIdentifier, commit, branch, controlPath, direction, maxDepth } = params;

  let startingNoteUuid = noteUuid;
  let resolvedCommit = commit;
  let resolvedBranch = branch;
  let matchedControlPath: string | undefined;

  // If no noteUuid provided, try to find notes for asset
  if (!startingNoteUuid && assetIdentifier) {
    // Use resolveAssetContext to handle asset/branch/commit resolution
    const context = await consulta.resolveAssetContext(assetIdentifier, { branch, commit });
    
    if (!context.assetUuid) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `Could not resolve asset "${assetIdentifier}"`,
            hint: 'Check that the asset name or UUID is correct',
          }, null, 2)
        }],
      };
    }

    // Get the resolved commit (from branch or explicit commit)
    resolvedCommit = context.resolvedCommit;
    resolvedBranch = context.resolvedBranch || context.defaultBranch;
    
    if (!resolvedCommit) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `Could not find any commits for asset "${assetIdentifier}" on branch "${resolvedBranch || 'default'}"`,
            hint: 'The asset may not have any pipeline runs yet',
            context: {
              asset: context.assetName,
              assetUuid: context.assetUuid,
              defaultBranch: context.defaultBranch,
            }
          }, null, 2)
        }],
      };
    }

    console.log(`[get_evidence_chain] Resolved: asset=${context.assetName}, branch=${resolvedBranch}, commit=${resolvedCommit}`);

    // Find notes for this commit
    const notes = await consulta.getNotesByCommit(resolvedCommit);
    if (notes.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: `No evidence found for commit ${resolvedCommit}`,
            hint: 'This commit may not have any pipeline runs or attestations',
            context: {
              asset: context.assetName,
              branch: resolvedBranch,
              commit: resolvedCommit,
            }
          }, null, 2)
        }],
      };
    }

    // If controlPath is provided, find an attestation matching that path
    if (controlPath) {
      const matchingAttestation = notes.find((n: any) => 
        n.type === 'attestation' && 
        n.path && 
        n.path.toLowerCase().includes(controlPath.toLowerCase())
      );
      
      if (matchingAttestation) {
        startingNoteUuid = matchingAttestation.uuid;
        matchedControlPath = matchingAttestation.path;
        console.log(`[get_evidence_chain] Found attestation matching "${controlPath}": ${matchingAttestation.uuid} (${matchingAttestation.path})`);
      } else {
        // Try to find any note with matching path (might be an occurrence)
        const matchingNote = notes.find((n: any) => 
          n.path && n.path.toLowerCase().includes(controlPath.toLowerCase())
        );
        
        if (matchingNote) {
          startingNoteUuid = matchingNote.uuid;
          matchedControlPath = matchingNote.path;
          console.log(`[get_evidence_chain] Found note matching "${controlPath}": ${matchingNote.uuid} (${matchingNote.path})`);
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `No attestation found matching "${controlPath}" for commit ${resolvedCommit}`,
                hint: 'Check the control path or try without controlPath to see all available evidence',
                availableNotes: notes.map((n: any) => ({
                  type: n.type,
                  path: n.path,
                  result: n.result,
                })),
              }, null, 2)
            }],
          };
        }
      }
    } else {
      // No controlPath - find the origin note (root of the chain)
      const originNote = notes.find((n: any) => n.type === 'origin');
      if (originNote) {
        startingNoteUuid = originNote.uuid;
      } else {
        // Use the first note found
        startingNoteUuid = notes[0].uuid;
      }
    }
  }

  if (!startingNoteUuid) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'No starting point found',
          hint: 'Provide noteUuid, or assetIdentifier (optionally with branch/commit/controlPath)',
        }, null, 2)
      }],
    };
  }

  try {
    let upstreamChain: ChainNode[] = [];
    let downstreamTree: ChainNode | null = null;
    let startingNode: ChainNode | null = null;

    // Get upstream chain (ancestors to origin)
    if (direction === 'upstream' || direction === 'full') {
      const chainData = await consulta.getEvidenceChain(startingNoteUuid);
      upstreamChain = chainData.map((item: any) => formatChainNode(item));
      
      // The last item in upstream chain is our starting node
      if (upstreamChain.length > 0) {
        startingNode = upstreamChain[upstreamChain.length - 1];
      }
    }

    // Get downstream tree (children)
    if (direction === 'downstream' || direction === 'full') {
      // First get the starting node if we don't have it
      if (!startingNode) {
        const noteDetails = await consulta.getAttestationDetails(startingNoteUuid);
        if (noteDetails) {
          startingNode = {
            uuid: startingNoteUuid,
            type: noteDetails.type || 'unknown',
            path: noteDetails.note?.path || noteDetails.path || '',
            result: noteDetails.result,
          };
        }
      }

      // Build downstream tree recursively
      if (startingNode) {
        downstreamTree = await buildDownstreamTree(consulta, startingNoteUuid, startingNode, 0, maxDepth || 10);
      }
    }

    // Build the response
    const response: any = {
      summary: buildSummary(upstreamChain, downstreamTree, direction || 'upstream'),
      startingPoint: {
        uuid: startingNoteUuid,
        type: startingNode?.type,
        path: startingNode?.path,
      },
    };

    // Add context about what was resolved (helpful for user understanding)
    if (assetIdentifier && !noteUuid) {
      response.context = {
        asset: assetIdentifier,
        branch: resolvedBranch || 'default',
        commit: resolvedCommit,
        ...(matchedControlPath && { matchedControlPath }),
      };
    }

    if (direction === 'upstream' || direction === 'full') {
      response.upstreamChain = {
        description: 'Lineage from origin to the starting note (oldest first)',
        nodes: upstreamChain.map(n => ({
          uuid: n.uuid,
          type: n.type,
          path: n.path,
          result: n.result || undefined,
          controlName: n.controlName || undefined,
          parentUuid: n.parentUuid || undefined,
        })),
        origin: upstreamChain.length > 0 ? {
          uuid: upstreamChain[0].uuid,
          type: upstreamChain[0].type,
          path: upstreamChain[0].path,
        } : null,
      };
    }

    if (direction === 'downstream' || direction === 'full') {
      response.downstreamTree = {
        description: 'Children derived from this note',
        root: downstreamTree ? formatTreeForOutput(downstreamTree) : null,
      };
    }

    // Add insights
    response.insights = generateChainInsights(upstreamChain, downstreamTree);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    };
  } catch (error) {
    console.error('Error getting evidence chain:', error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Failed to get evidence chain',
          message: error instanceof Error ? error.message : String(error),
          noteUuid: startingNoteUuid,
        }, null, 2)
      }],
    };
  }
}

/**
 * Format a chain item from the API response into a ChainNode
 */
function formatChainNode(item: any): ChainNode {
  const note = item.note || {};
  return {
    uuid: note.uuid || item.uuid,
    type: item.type || note.type || 'unknown',
    path: note.path || item.path || '',
    result: item.result || undefined,
    controlName: item.control?.name || undefined,
    controlPath: item.control?.path || undefined,
    timestamp: item.date || note.timestamp || undefined,
    parentUuid: note.parent?.uuid || undefined,
    provenance: item.provenance?.slice(0, 3), // Limit provenance to first 3 sources
  };
}

/**
 * Recursively build the downstream tree of children
 */
async function buildDownstreamTree(
  consulta: ConsultaClient,
  parentUuid: string,
  parentNode: ChainNode,
  currentDepth: number,
  maxDepth: number
): Promise<ChainNode> {
  const node: ChainNode = { ...parentNode };

  if (currentDepth >= maxDepth) {
    return node;
  }

  try {
    // Get children notes
    const children = await consulta.getNotesByParent(parentUuid);
    
    if (children.length > 0) {
      node.children = [];
      
      for (const child of children) {
        const childNode: ChainNode = {
          uuid: child.uuid,
          type: child.type || 'unknown',
          path: child.path || '',
          result: child.result,
          parentUuid: parentUuid,
        };

        // Recursively get children of this child
        const childWithDescendants = await buildDownstreamTree(
          consulta,
          child.uuid,
          childNode,
          currentDepth + 1,
          maxDepth
        );
        
        node.children.push(childWithDescendants);
      }
    }
  } catch (error) {
    console.warn(`Failed to get children for ${parentUuid}:`, error);
  }

  return node;
}

/**
 * Format the tree for output (simplify structure)
 */
function formatTreeForOutput(node: ChainNode): any {
  const output: any = {
    uuid: node.uuid,
    type: node.type,
    path: node.path,
  };
  
  if (node.result) output.result = node.result;
  if (node.controlName) output.controlName = node.controlName;
  
  if (node.children && node.children.length > 0) {
    output.children = node.children.map(c => formatTreeForOutput(c));
  }
  
  return output;
}

/**
 * Build a summary of the chain
 */
function buildSummary(
  upstreamChain: ChainNode[],
  downstreamTree: ChainNode | null,
  direction: string
): string {
  const parts: string[] = [];

  if (upstreamChain.length > 0) {
    const origin = upstreamChain[0];
    const attestations = upstreamChain.filter(n => n.type === 'attestation');
    const passing = attestations.filter(a => a.result === 'pass').length;
    const failing = attestations.filter(a => a.result === 'fail').length;

    parts.push(`Chain has ${upstreamChain.length} nodes from origin (${origin.path || origin.type})`);
    if (attestations.length > 0) {
      parts.push(`${attestations.length} attestation(s): ${passing} passing, ${failing} failing`);
    }
  }

  if (downstreamTree?.children) {
    const childCount = countDescendants(downstreamTree);
    parts.push(`${childCount} downstream node(s)`);
  }

  return parts.join('. ') || 'Evidence chain retrieved';
}

/**
 * Count total descendants in a tree
 */
function countDescendants(node: ChainNode): number {
  let count = node.children?.length || 0;
  for (const child of node.children || []) {
    count += countDescendants(child);
  }
  return count;
}

/**
 * Generate insights about the chain
 */
function generateChainInsights(
  upstreamChain: ChainNode[],
  downstreamTree: ChainNode | null
): string[] {
  const insights: string[] = [];

  // Analyze upstream chain
  if (upstreamChain.length > 0) {
    const origin = upstreamChain[0];
    const attestations = upstreamChain.filter(n => n.type === 'attestation');
    const occurrences = upstreamChain.filter(n => n.type === 'occurrence');

    // Origin insight
    if (origin.path?.includes('github')) {
      insights.push('🔗 Chain originated from GitHub workflow');
    } else if (origin.path) {
      insights.push(`🔗 Chain originated from: ${origin.path}`);
    }

    // Attestation insights
    const failingAttestations = attestations.filter(a => a.result === 'fail');
    if (failingAttestations.length > 0) {
      const failingPaths = failingAttestations.map(a => a.controlName || a.path).join(', ');
      insights.push(`❌ Failing controls in chain: ${failingPaths}`);
    } else if (attestations.length > 0) {
      insights.push(`✅ All ${attestations.length} control(s) in chain are passing`);
    }

    // Data sources
    const integrations = new Set<string>();
    for (const node of upstreamChain) {
      if (node.provenance) {
        for (const p of node.provenance) {
          if (p.integration) integrations.add(p.integration.trim());
        }
      }
    }
    if (integrations.size > 0) {
      insights.push(`📊 Data sources: ${Array.from(integrations).join(', ')}`);
    }
  }

  // Analyze downstream tree
  if (downstreamTree?.children && downstreamTree.children.length > 0) {
    const totalChildren = countDescendants(downstreamTree);
    insights.push(`🌳 ${totalChildren} downstream evidence record(s) derived from this point`);
  }

  return insights;
}

