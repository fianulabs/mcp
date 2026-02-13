import { z } from 'zod';
import { ConsultaClient } from '../api/consulta-client';
import type { Env, SessionState } from '../types';

export const getCommitAuthorsSchema = z.object({
  assetIdentifier: z.string().describe(
    'REQUIRED: Repository name or UUID'
  ),
  branch: z.string().optional().describe(
    'Optional: Branch name (e.g., "main")'
  ),
  commit: z.string().optional().describe(
    'Optional: Specific commit SHA to look up'
  ),
});

export type GetCommitAuthorsInput = z.infer<typeof getCommitAuthorsSchema>;

export interface CommitAuthorResponse {
  authors: Array<{
    name: string;
    email: string;
    login?: string;
    commitSha?: string;
    message?: string;
  }>;
  asset: string;
  branch?: string;
  totalCommits: number;
  insights: string[];
  limitations: string[];
}

export async function getCommitAuthorsHandler(
  input: GetCommitAuthorsInput,
  env: Env,
  session: SessionState
): Promise<CommitAuthorResponse> {
  const { assetIdentifier, branch, commit } = input;
  console.log(`[getCommitAuthorsHandler] asset=${assetIdentifier}, branch=${branch || 'any'}, commit=${commit || 'latest'}`);

  const client = new ConsultaClient(env, session);
  const insights: string[] = [];
  const limitations: string[] = [
    'Returns authors from most recent commit history attestation only',
    'Requires ci.commithistory.codereview attestations from CI pipeline',
  ];

  try {
    // Check if assetIdentifier is already a UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(assetIdentifier);
    
    let assetUuid: string | undefined;
    let assetName = assetIdentifier;
    
    if (isUuid) {
      // Direct UUID - use it directly
      assetUuid = assetIdentifier;
      console.log(`[getCommitAuthorsHandler] Using UUID directly: ${assetUuid}`);
    } else {
      // Resolve asset name to UUID
      const resolved = await client.resolveAssetContext(assetIdentifier);
      assetUuid = resolved.assetUuid || undefined;
      assetName = resolved.assetName || assetIdentifier;
      console.log(`[getCommitAuthorsHandler] Resolved "${assetIdentifier}" to: uuid=${assetUuid}, name=${assetName}`);
    }

    // Build a simple query - just get the most recent commit history for this asset
    const queryParams = new URLSearchParams();
    queryParams.set('type', 'attestation');
    queryParams.set('path', 'ci.commithistory.codereview');
    queryParams.set('limit', '5');
    
    if (assetUuid) {
      queryParams.set('asset', assetUuid);  // API expects 'asset' not 'assetId'
    } else {
      console.warn(`[getCommitAuthorsHandler] No assetUuid found, querying without asset filter`);
    }

    const notesUrl = `/notes?${queryParams.toString()}`;
    console.log(`[getCommitAuthorsHandler] Fetching: ${notesUrl}`);

    const notesData = await client.fetch<any>(notesUrl);
    const notes = Array.isArray(notesData) ? notesData : (notesData.notes || notesData.data || []);
    
    console.log(`[getCommitAuthorsHandler] Found ${notes.length} commit history notes`);

    if (notes.length === 0) {
      // Return in MCP content format
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            authors: [],
            asset: assetName,
            branch,
            totalCommits: 0,
            insights: ['No commit history attestations found for this asset'],
            limitations,
          }, null, 2)
        }],
      };
    }

    // Filter by branch/commit if specified
    let targetNote = notes[0];
    
    if (branch || commit) {
      for (const note of notes) {
        const detail = note.detail || {};
        const noteBranch = detail.branch || detail.ref || '';
        const commits = detail.commits || [];
        
        if (branch && !noteBranch.toLowerCase().includes(branch.toLowerCase())) {
          continue;
        }
        
        if (commit) {
          const hasCommit = commits.some((c: any) => c.sha?.startsWith(commit));
          if (!hasCommit && !detail.headCommit?.sha?.startsWith(commit)) {
            continue;
          }
        }
        
        targetNote = note;
        break;
      }
    }

    // Extract authors from the attestation
    const detail = targetNote.detail || {};
    const commits = detail.commits || [];
    const authors: CommitAuthorResponse['authors'] = [];
    const seen = new Set<string>();

    for (const c of commits) {
      if (c.author?.email) {
        const key = c.author.email.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          authors.push({
            name: c.author.name || 'Unknown',
            email: c.author.email,
            login: c.author.login,
            commitSha: c.sha?.substring(0, 7),
            message: c.message?.split('\n')[0]?.substring(0, 60),
          });
        }
      }
    }

    // Generate insights
    if (authors.length > 0) {
      insights.push(`Found ${authors.length} author(s) in ${commits.length} commit(s)`);
    }
    if (detail.branch) {
      insights.push(`Branch: ${detail.branch}`);
    }
    if (detail.pr?.number) {
      insights.push(`PR #${detail.pr.number}: ${detail.pr.title || ''}`);
    }

    const response = {
      authors,
      asset: targetNote.asset?.name || assetIdentifier,
      branch: detail.branch,
      totalCommits: commits.length,
      insights,
      limitations,
    };

    // Return in MCP content format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    };

  } catch (error: any) {
    console.error(`[getCommitAuthorsHandler] Error:`, error);
    throw new Error(`Failed to get commit authors: ${error.message}`);
  }
}
