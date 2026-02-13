/**
 * Analyze Control Failure Tool
 * 
 * Fetches OPA Rego policy code for a control and explains why it's failing.
 * Shows policy thresholds, rule logic, and measured values.
 * 
 * IMPORTANT: MCP tool schemas MUST use plain JSON Schema objects, NOT Zod.
 * Zod schemas will fail to serialize and break tool registration.
 * See README.md "Adding New Tools" section for the correct pattern.
 */

import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

export const analyzeControlFailureSchema = {
  type: 'object',
  properties: {
    controlPath: {
      type: 'string',
      description: 'Control path to analyze (e.g., "cycode.secret.detection", "sonarqube.codescan.coverage"). You can also provide a control UUID.',
    },
    assetIdentifier: {
      type: 'string',
      description: 'Optional: Asset name or repository to find a specific failing attestation for context (e.g., "fianu-fullstack-demo"). If provided, shows measured values from actual attestation.',
    },
    branch: {
      type: 'string',
      description: 'Optional: Branch name (e.g., "main", "develop"). Only used with assetIdentifier.',
    },
    commit: {
      type: 'string',
      description: 'Optional: Specific commit SHA to analyze (e.g., "3e2ab4d"). Only used with assetIdentifier. If omitted, uses latest commit.',
    },
  },
  required: ['controlPath'],
};

interface RegoRuleClause {
  name: string;
  condition: string;
  explanation: string;
}

interface ControlAnalysis {
  control: {
    name: string;
    path: string;
    displayKey?: string;
    description?: string;
    uuid: string;
  };
  // Context about what was analyzed (for transparency)
  context?: {
    asset?: string;
    application?: string;
    repository?: string;
    branch?: string;
    commit?: string;
    timestamp?: string;
    result?: string;
  };
  assumptions?: string[];  // What we assumed when user was vague
  rego: {
    fullPolicy: string;
    packageName: string;
    imports: string[];
    rules: RegoRuleClause[];
    rawLength: number;
  } | null;
  policyData: {
    thresholds: Record<string, any>;
    raw: any;
  } | null;
  preprocessor: {
    language: string;
    summary: string;
    code: string;
  } | null;
  failingAttestation?: {
    uuid: string;
    result: string;
    timestamp: string;
    assetName: string;
    commit?: string;
    branch?: string;
    measuredValues?: Record<string, any>;
  };
  analysis: {
    whatItChecks: string;
    possibleFailureReasons: string[];
    recommendations: string[];
  };
  insights: string[];
}

/**
 * Parse OPA Rego policy to extract rule clauses
 */
function parseRegoPolicy(regoCode: string): {
  packageName: string;
  imports: string[];
  rules: RegoRuleClause[];
} {
  const lines = regoCode.split('\n');
  const packageMatch = regoCode.match(/package\s+(\w+)/);
  const packageName = packageMatch ? packageMatch[1] : 'unknown';
  
  // Extract imports
  const imports: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('import ')) {
      imports.push(line.trim());
    }
  }
  
  // Extract rule clauses (pass, fail, notFound, notRequired, warn)
  const rules: RegoRuleClause[] = [];
  const rulePatterns = [
    { name: 'pass', pattern: /^pass\s+(if\s+)?{/m },
    { name: 'fail', pattern: /^fail\s+(if\s+)?{/m },
    { name: 'notFound', pattern: /^notFound\s+(if\s+)?{/m },
    { name: 'notRequired', pattern: /^notRequired\s+(if\s+)?{/m },
    { name: 'warn', pattern: /^warn\s+(if\s+)?{/m },
  ];
  
  for (const { name, pattern } of rulePatterns) {
    // Find all occurrences of this rule type
    const regex = new RegExp(`^${name}\\s+(if\\s+)?\\{([\\s\\S]*?)^\\}`, 'gm');
    let match;
    
    while ((match = regex.exec(regoCode)) !== null) {
      const condition = match[2]?.trim() || '';
      rules.push({
        name,
        condition,
        explanation: explainRegoCondition(name, condition),
      });
    }
    
    // Also check for simple assignments like "default fail = false"
    const defaultMatch = regoCode.match(new RegExp(`default\\s+${name}\\s*=\\s*(true|false)`));
    if (defaultMatch) {
      rules.push({
        name: `default ${name}`,
        condition: defaultMatch[1],
        explanation: `Default value for "${name}" is ${defaultMatch[1]}`,
      });
    }
  }
  
  return { packageName, imports, rules };
}

/**
 * Generate human-readable explanation for a Rego condition
 */
function explainRegoCondition(ruleName: string, condition: string): string {
  if (!condition.trim()) {
    return `Rule "${ruleName}" has no explicit conditions`;
  }
  
  const explanations: string[] = [];
  
  // Check for common patterns
  if (condition.includes('input.detail')) {
    explanations.push('Examines attestation details');
  }
  if (condition.includes('data.')) {
    explanations.push('Uses policy threshold values');
  }
  if (condition.includes('count(')) {
    explanations.push('Counts items in a collection');
  }
  if (condition.includes('>=') || condition.includes('<=') || condition.includes('>') || condition.includes('<')) {
    explanations.push('Compares values against thresholds');
  }
  if (condition.includes('== true') || condition.includes('== false')) {
    explanations.push('Checks boolean conditions');
  }
  if (condition.includes('required')) {
    explanations.push('Checks if control is required');
  }
  if (condition.includes('coverage')) {
    explanations.push('Evaluates code coverage percentage');
  }
  if (condition.includes('vulnerabilities') || condition.includes('secrets')) {
    explanations.push('Checks security scan findings');
  }
  
  if (explanations.length === 0) {
    return `Evaluates: ${condition.substring(0, 100)}${condition.length > 100 ? '...' : ''}`;
  }
  
  return explanations.join('; ');
}

/**
 * Generate analysis of what the control checks and why it might fail
 */
function generateAnalysis(
  controlName: string,
  controlPath: string,
  rules: RegoRuleClause[],
  policyData: any
): { whatItChecks: string; possibleFailureReasons: string[]; recommendations: string[] } {
  
  const failRules = rules.filter(r => r.name === 'fail');
  const passRules = rules.filter(r => r.name === 'pass');
  
  let whatItChecks = `The "${controlName}" control `;
  
  // Infer what the control checks from the path and rules
  if (controlPath.includes('secret')) {
    whatItChecks += 'scans for exposed secrets and credentials in the codebase.';
  } else if (controlPath.includes('coverage')) {
    whatItChecks += 'verifies that code coverage meets the minimum threshold.';
  } else if (controlPath.includes('vulnerability') || controlPath.includes('sca') || controlPath.includes('dependabot')) {
    whatItChecks += 'checks for known vulnerabilities in dependencies.';
  } else if (controlPath.includes('sast') || controlPath.includes('codescan')) {
    whatItChecks += 'performs static analysis to find code quality and security issues.';
  } else if (controlPath.includes('sbom')) {
    whatItChecks += 'verifies a Software Bill of Materials has been generated.';
  } else if (controlPath.includes('signing') || controlPath.includes('cosign')) {
    whatItChecks += 'ensures artifacts are cryptographically signed.';
  } else if (controlPath.includes('testing') || controlPath.includes('junit')) {
    whatItChecks += 'verifies that automated tests have been executed.';
  } else {
    whatItChecks += `evaluates compliance for the "${controlPath}" check.`;
  }
  
  // Generate possible failure reasons from fail rules
  const possibleFailureReasons: string[] = [];
  
  for (const rule of failRules) {
    if (rule.condition.includes('count') && rule.condition.includes('>')) {
      possibleFailureReasons.push('Too many issues found (count exceeds threshold)');
    }
    if (rule.condition.includes('coverage') && rule.condition.includes('<')) {
      possibleFailureReasons.push('Code coverage below minimum threshold');
    }
    if (rule.condition.includes('required') && rule.condition.includes('true')) {
      possibleFailureReasons.push('Required evidence is missing');
    }
    if (rule.condition.includes('secrets')) {
      possibleFailureReasons.push('Secrets or credentials detected in code');
    }
    if (rule.condition.includes('vulnerabilities')) {
      possibleFailureReasons.push('Vulnerabilities found above acceptable threshold');
    }
  }
  
  // Add threshold-based reasons from policy data
  if (policyData) {
    if (policyData.minimum_coverage) {
      possibleFailureReasons.push(`Coverage below ${policyData.minimum_coverage}%`);
    }
    if (policyData.maximum_critical !== undefined) {
      possibleFailureReasons.push(`More than ${policyData.maximum_critical} critical issues`);
    }
    if (policyData.maximum_high !== undefined) {
      possibleFailureReasons.push(`More than ${policyData.maximum_high} high severity issues`);
    }
    if (policyData.required === true) {
      possibleFailureReasons.push('Control is required but no evidence was submitted');
    }
  }
  
  if (possibleFailureReasons.length === 0) {
    possibleFailureReasons.push('Policy conditions not met (review Rego rules for specifics)');
  }
  
  // Generate recommendations
  const recommendations: string[] = [];
  
  if (controlPath.includes('secret')) {
    recommendations.push('Scan codebase for hardcoded secrets and remove them');
    recommendations.push('Use environment variables or secret management tools');
  } else if (controlPath.includes('coverage')) {
    recommendations.push('Add more unit tests to increase code coverage');
    recommendations.push('Review policy threshold to ensure it\'s appropriate');
  } else if (controlPath.includes('vulnerability')) {
    recommendations.push('Update dependencies to patched versions');
    recommendations.push('Review and triage vulnerability findings');
  } else if (controlPath.includes('sast')) {
    recommendations.push('Fix identified code quality issues');
    recommendations.push('Review false positives and configure exclusions');
  } else {
    recommendations.push('Review the failing attestation for specific details');
    recommendations.push('Ensure required evidence is being generated in CI/CD');
  }
  
  return { whatItChecks, possibleFailureReasons, recommendations };
}

export const analyzeControlFailureHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<any> => {
  const client = new ConsultaClient(env, session);
  const controlPath = args.controlPath as string;
  const assetIdentifier = args.assetIdentifier as string | undefined;
  const branch = args.branch as string | undefined;
  const commit = args.commit as string | undefined;
  
  const insights: string[] = [];
  const assumptions: string[] = [];
  
  // Track what was explicitly provided vs assumed
  if (assetIdentifier && !branch && !commit) {
    assumptions.push('No branch or commit specified - using the most recent attestation data');
  } else if (assetIdentifier && branch && !commit) {
    assumptions.push(`Using branch "${branch}" but no specific commit - showing latest on that branch`);
  }
  
  // Step 1: Fetch control with Rego
  console.log(`[analyzeControlFailure] Fetching control: ${controlPath}`);
  const controlResult = await client.getControlWithRego(controlPath);
  
  if (!controlResult.found || !controlResult.control) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          found: false,
          error: controlResult.error || `Control not found: ${controlPath}`,
          insights: [
            'The control path may be incorrect or the control may not exist in this tenant.',
            'Use list_controls to see available controls.',
          ],
        }, null, 2),
      }],
    };
  }
  
  insights.push(`Found control: ${controlResult.control.name} (${controlResult.control.path})`);
  
  // Step 2: Parse the Rego policy
  let parsedRego: {
    packageName: string;
    imports: string[];
    rules: RegoRuleClause[];
  } | null = null;
  
  if (controlResult.rego?.decoded) {
    parsedRego = parseRegoPolicy(controlResult.rego.decoded);
    insights.push(`Parsed Rego policy: ${parsedRego.rules.length} rule clauses found`);
  } else {
    insights.push('No OPA Rego policy found for this control');
  }
  
  // Step 3: Optionally fetch attestation for context
  let failingAttestation: ControlAnalysis['failingAttestation'] | undefined;
  let analysisContext: ControlAnalysis['context'] | undefined;
  
  if (assetIdentifier) {
    console.log(`[analyzeControlFailure] Looking for attestation in ${assetIdentifier}${branch ? ` (branch: ${branch})` : ''}${commit ? ` (commit: ${commit})` : ''}`);
    const attestationResult = await client.getFailingAttestationForAnalysis(
      assetIdentifier,
      controlPath,
      { branch, commit }
    );
    
    if (attestationResult.found && attestationResult.attestation) {
      const att = attestationResult.attestation;
      
      // Build context to show exactly what we analyzed
      analysisContext = {
        asset: att.assetName,
        repository: att.assetName,
        branch: att.branch || branch || 'default branch',
        commit: att.commit,
        timestamp: att.timestamp,
        result: att.result,
      };
      
      // Note if we used a different commit than requested
      if (commit && att.commit && !att.commit.startsWith(commit)) {
        assumptions.push(`Requested commit "${commit}" not found - showing closest available: ${att.commit?.substring(0, 7)}`);
      }
      
      failingAttestation = {
        uuid: att.uuid,
        result: att.result,
        timestamp: att.timestamp,
        assetName: att.assetName,
        commit: att.commit,
        branch: att.branch || branch,
        measuredValues: att.detail,
      };
      
      // Clear message about what we found
      const resultLabel = att.result === 'fail' ? 'FAILING' : att.result === 'pass' ? 'PASSING' : att.result?.toUpperCase();
      insights.push(`Analyzed ${resultLabel} attestation from ${att.timestamp} (commit: ${att.commit?.substring(0, 7) || 'unknown'})`);
    } else {
      insights.push(`No attestation found for ${controlPath} in ${assetIdentifier}`);
      if (!commit && !branch) {
        insights.push('Try specifying a branch or commit to find specific attestation data');
      }
    }
  } else {
    insights.push('No asset specified - showing control policy only (add assetIdentifier to see actual measured values)');
  }
  
  // Step 4: Generate analysis
  const analysis = generateAnalysis(
    controlResult.control.name,
    controlResult.control.path,
    parsedRego?.rules || [],
    controlResult.policyData?.decoded
  );
  
  // Build response
  const response: ControlAnalysis = {
    control: {
      name: controlResult.control.name,
      path: controlResult.control.path,
      displayKey: controlResult.control.displayKey,
      description: controlResult.control.description,
      uuid: controlResult.control.uuid,
    },
    // Show exactly what we analyzed (transparency)
    context: analysisContext,
    // Show what we assumed when user was vague
    assumptions: assumptions.length > 0 ? assumptions : undefined,
    rego: parsedRego ? {
      fullPolicy: controlResult.rego?.decoded || '',
      packageName: parsedRego.packageName,
      imports: parsedRego.imports,
      rules: parsedRego.rules,
      rawLength: controlResult.rego?.decoded?.length || 0,
    } : null,
    policyData: controlResult.policyData ? {
      thresholds: controlResult.policyData.decoded,
      raw: controlResult.policyData.decoded,
    } : null,
    preprocessor: controlResult.preprocessor ? {
      language: 'Python',
      summary: 'Preprocessing logic that transforms occurrence data before policy evaluation',
      code: controlResult.preprocessor.decoded.substring(0, 500) + 
            (controlResult.preprocessor.decoded.length > 500 ? '\n... (truncated)' : ''),
    } : null,
    failingAttestation,
    analysis,
    insights,
  };
  
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(response, null, 2),
    }],
  };
};

