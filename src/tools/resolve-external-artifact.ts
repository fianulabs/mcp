import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * Parsed artifact reference
 */
interface ParsedArtifact {
  registry?: string;
  repository?: string;
  image?: string;
  tag?: string;
  digest?: string;
  fullUri: string;
  type: 'docker' | 'oci' | 'generic' | 'unknown';
}

/**
 * Resolved asset information
 */
interface ResolvedAsset {
  repository: {
    uuid: string;
    name: string;
    key: string;
  };
  application: {
    uuid: string;
    name: string;
    code: string;
  } | null;
  module: {
    uuid: string;
    name: string;
  } | null;
  commit: string;
  branch?: string;
  artifact: {
    digest: string;
    uri: string;
  };
}

/**
 * Response from resolve_external_artifact tool
 */
interface ResolveArtifactResponse {
  found: boolean;
  input: {
    uri: string;
    parsed: ParsedArtifact;
  };
  asset?: ResolvedAsset;
  dashboardUrl?: string;
  complianceStatus?: {
    summary: string;
    controlsChecked: number;
    passing: number;
    failing: number;
  };
  insights: string[];
  error?: string;
}

/**
 * Tool schema for resolve_external_artifact
 */
export const resolveExternalArtifactSchema = {
  type: 'object',
  properties: {
    artifactUri: {
      type: 'string',
      description: 'The artifact URI from Artifactory, container registry, or other external tool. Examples: "ghcr.io/org/repo/image@sha256:abc123...", "sha256:abc123...", "artifactory.example.com/docker-local/myimage:v1.2.3"',
    },
  },
  required: ['artifactUri'],
};

/**
 * Parse an artifact URI to extract registry, image, tag, and digest
 */
function parseArtifactUri(uri: string): ParsedArtifact {
  const trimmed = uri.trim();
  
  // Case 1: Just a digest (sha256:...)
  if (trimmed.startsWith('sha256:')) {
    return {
      digest: trimmed,
      fullUri: trimmed,
      type: 'docker',
    };
  }
  
  // Case 2: Full container image reference
  // Format: [registry/][repository/]image[:tag][@digest]
  
  let remaining = trimmed;
  let registry: string | undefined;
  let digest: string | undefined;
  let tag: string | undefined;
  
  // Extract digest if present (after @)
  if (remaining.includes('@')) {
    const [beforeDigest, afterDigest] = remaining.split('@');
    remaining = beforeDigest;
    digest = afterDigest.startsWith('sha256:') ? afterDigest : `sha256:${afterDigest}`;
  }
  
  // Extract tag if present (after :, but not if it's a port)
  const lastColon = remaining.lastIndexOf(':');
  if (lastColon > -1) {
    const afterColon = remaining.slice(lastColon + 1);
    // Check if this looks like a tag (not a port number or digest)
    if (!/^\d+$/.test(afterColon) && !afterColon.includes('/')) {
      tag = afterColon;
      remaining = remaining.slice(0, lastColon);
    }
  }
  
  // Split by / to get parts
  const parts = remaining.split('/');
  
  // Determine registry vs repository vs image
  // If first part has a dot or port, it's likely a registry
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':'))) {
    registry = parts[0];
    parts.shift();
  }
  
  // Last part is the image name
  const image = parts.pop();
  
  // Remaining parts are the repository path
  const repository = parts.length > 0 ? parts.join('/') : undefined;
  
  return {
    registry,
    repository,
    image,
    tag,
    digest,
    fullUri: trimmed,
    type: registry?.includes('artifactory') ? 'generic' : 'docker',
  };
}

/**
 * Handler for resolve_external_artifact tool
 * 
 * Resolves an artifact URI from Artifactory or container registries to Fianu assets.
 * Returns the corresponding repository, commit, and Fianu dashboard URL.
 */
export const resolveExternalArtifactHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<any> => {
  const client = new ConsultaClient(env, session);
  
  const artifactUri = args.artifactUri as string;
  
  if (!artifactUri) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          found: false,
          error: 'artifactUri is required',
          insights: ['Please provide an artifact URI to resolve.'],
        }, null, 2)
      }],
    };
  }
  
  console.log(`[resolve_external_artifact] Resolving: ${artifactUri}`);
  
  const parsed = parseArtifactUri(artifactUri);
  const insights: string[] = [];
  
  console.log(`[resolve_external_artifact] Parsed:`, JSON.stringify(parsed));
  
  try {
    // Strategy 1: Search by digest if available
    // Strategy 2: Search by image/repository name
    // We'll query notes to find matching attestations
    
    let matchingNote: any = null;
    
    // Build search query
    const searchParams: Record<string, string> = {
      kind: 'attestation',
      limit: '50',
    };
    
    // If we have a digest, we can search for it
    if (parsed.digest) {
      insights.push(`Searching by digest: ${parsed.digest.slice(0, 20)}...`);
    }
    
    // If we have a repository/image name, add it to search
    // The API expects just the repo name, not the full path (e.g., "fianu-fullstack-demo" not "fianulabs-demos/fianu-fullstack-demo")
    if (parsed.repository) {
      // Extract just the last part of the repository path
      const repoParts = parsed.repository.split('/');
      const repoName = repoParts[repoParts.length - 1] || parsed.repository;
      searchParams.repository = repoName;
      insights.push(`Searching in repository: ${repoName}`);
    } else if (parsed.image) {
      searchParams.repository = parsed.image;
      insights.push(`Searching by image name: ${parsed.image}`);
    }
    
    // Fetch attestation notes
    const queryString = Object.entries(searchParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    
    console.log(`[resolve_external_artifact] Querying /notes?${queryString}`);
    
    const notesResponse = await client.fetch<any[]>(`/notes?${queryString}`);
    const notes = Array.isArray(notesResponse) ? notesResponse : [];
    
    console.log(`[resolve_external_artifact] Found ${notes.length} notes`);
    
    // Search through notes for matching digest or URI
    for (const note of notes) {
      const assetDigest = note.asset?.version?.digest || note.asset?.key;
      const assetUri = note.asset?.version?.uri || note.asset?.ref;
      
      // Match by digest
      if (parsed.digest && assetDigest) {
        if (assetDigest === parsed.digest || assetDigest.includes(parsed.digest) || parsed.digest.includes(assetDigest)) {
          matchingNote = note;
          insights.push(`Found matching attestation by digest.`);
          break;
        }
      }
      
      // Match by URI
      if (assetUri && parsed.fullUri) {
        if (assetUri.includes(parsed.fullUri) || parsed.fullUri.includes(assetUri)) {
          matchingNote = note;
          insights.push(`Found matching attestation by URI.`);
          break;
        }
      }
      
      // Match by image name in URI
      if (parsed.image && assetUri) {
        if (assetUri.includes(parsed.image)) {
          matchingNote = note;
          insights.push(`Found matching attestation by image name.`);
          break;
        }
      }
    }
    
    if (!matchingNote) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            found: false,
            input: {
              uri: artifactUri,
              parsed,
            },
            insights: [
              ...insights,
              'No matching attestation found for this artifact.',
              'The artifact may not have been scanned yet, or the digest/URI may not match any known assets.',
            ],
          }, null, 2)
        }],
      };
    }
    
    // Extract asset information from the matching note
    const asset = matchingNote.asset;
    const scm = asset?.scm?.repository || {};
    const parent = asset?.parent || {};
    const appParent = parent?.parent || {};
    
    const resolvedAsset: ResolvedAsset = {
      repository: {
        uuid: parent?.uuid || '',
        name: parent?.name || scm?.name || '',
        key: parent?.key || `${scm?.project}/${scm?.name}` || '',
      },
      application: appParent?.uuid ? {
        uuid: appParent.uuid,
        name: appParent.name || '',
        code: appParent.key || '',
      } : null,
      module: asset?.type?.name === 'module' ? {
        uuid: asset.uuid,
        name: asset.name,
      } : null,
      commit: scm?.commit || asset?.version?.commit || '',
      branch: scm?.branch,
      artifact: {
        digest: asset?.version?.digest || asset?.key || '',
        uri: asset?.version?.uri || asset?.ref || '',
      },
    };
    
    // Generate Fianu dashboard URL
    // Format: https://fianu-dev.fianu.io/{app_code}/{repo_name}/{commit}?branch={branch}
    // For modules: https://fianu-dev.fianu.io/{app_code}/{repo_name}/modules/{module_name}/{commit}
    
    const baseUrl = env.CONSULTA_URL?.replace('/api', '') || 'https://fianu-dev.fianu.io';
    const appCode = resolvedAsset.application?.code || scm?.project || '';
    const repoName = resolvedAsset.repository.name || scm?.name || '';
    const commit = resolvedAsset.commit;
    
    let dashboardUrl = '';
    if (appCode && repoName && commit) {
      if (resolvedAsset.module) {
        dashboardUrl = `${baseUrl}/${appCode}/${repoName}/modules/${resolvedAsset.module.name}/${commit}`;
      } else {
        dashboardUrl = `${baseUrl}/${appCode}/${repoName}/${commit}`;
        if (resolvedAsset.branch) {
          dashboardUrl += `?branch=${encodeURIComponent(resolvedAsset.branch)}`;
        }
      }
    }
    
    insights.push(`Repository: ${resolvedAsset.repository.name}`);
    insights.push(`Commit: ${resolvedAsset.commit.slice(0, 8)}...`);
    if (resolvedAsset.application) {
      insights.push(`Application: ${resolvedAsset.application.name}`);
    }
    if (dashboardUrl) {
      insights.push(`Dashboard URL generated successfully.`);
    }
    
    // Optionally get compliance status for the repository
    let complianceStatus = undefined;
    try {
      const compliance = await client.getAssetCompliance(resolvedAsset.repository.name);
      if (compliance) {
        const passing = compliance.controls.filter(c => c.status === 'pass').length;
        const failing = compliance.controls.filter(c => c.status === 'fail').length;
        complianceStatus = {
          summary: compliance.summary || `${passing}/${compliance.controls.length} controls passing`,
          controlsChecked: compliance.controls.length,
          passing,
          failing,
        };
      }
    } catch (e) {
      console.log(`[resolve_external_artifact] Could not fetch compliance status: ${e}`);
    }
    
    const response: ResolveArtifactResponse = {
      found: true,
      input: {
        uri: artifactUri,
        parsed,
      },
      asset: resolvedAsset,
      dashboardUrl: dashboardUrl || undefined,
      complianceStatus,
      insights,
    };
    
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    };
    
  } catch (error) {
    console.error('[resolve_external_artifact] Error:', error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          found: false,
          input: {
            uri: artifactUri,
            parsed,
          },
          error: error instanceof Error ? error.message : 'Unknown error',
          insights: [...insights, 'An error occurred while resolving the artifact.'],
        }, null, 2)
      }],
    };
  }
};

