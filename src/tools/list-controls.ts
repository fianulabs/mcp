import { z } from 'zod';
import type { ConsultaClient } from '../api/consulta-client';
import type { Control } from '../types';

/**
 * Schema for list_controls tool
 */
export const ListControlsSchema = z.object({
  framework: z.string().optional().describe('Filter by compliance framework (e.g., SLSA, SOC2, PCI-DSS)'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('Filter by severity level'),
});

export type ListControlsParams = z.infer<typeof ListControlsSchema>;

/**
 * List all compliance controls applicable to the organization
 */
export async function listControls(
  consulta: ConsultaClient,
  params: ListControlsParams
) {
  const controls = await consulta.listControls(params.framework, params.severity);

  // Group controls by framework and severity
  const groupedByFramework = groupBy(controls, 'framework');
  const groupedBySeverity = groupBy(controls, 'severity');

  // Generate summary
  const summary = generateControlsSummary(controls, params);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        summary,
        totalControls: controls.length,
        byFramework: Object.entries(groupedByFramework).map(([framework, ctrls]) => ({
          framework,
          count: ctrls.length,
        })),
        bySeverity: Object.entries(groupedBySeverity).map(([severity, ctrls]) => ({
          severity,
          count: ctrls.length,
        })),
        controls: controls.slice(0, 50), // Limit to first 50 for readability
        note: controls.length > 50 ? `Showing first 50 of ${controls.length} controls. Use filters to narrow results.` : undefined,
      }, null, 2)
    }],
  };
}

/**
 * Group array of objects by a key
 */
function groupBy<T extends Record<string, any>>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce((acc, item) => {
    const group = String(item[key]);
    if (!acc[group]) {
      acc[group] = [];
    }
    acc[group].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

/**
 * Generate AI-friendly summary of controls
 */
function generateControlsSummary(controls: Control[], filters: ListControlsParams): string {
  let summary = `Found ${controls.length} compliance control${controls.length !== 1 ? 's' : ''}`;

  if (filters.framework) {
    summary += ` for ${filters.framework} framework`;
  }

  if (filters.severity) {
    summary += ` with ${filters.severity} severity`;
  }

  // Count by severity
  const criticalCount = controls.filter(c => c.severity === 'critical').length;
  const highCount = controls.filter(c => c.severity === 'high').length;
  const mediumCount = controls.filter(c => c.severity === 'medium').length;

  if (criticalCount > 0) {
    summary += `. 🚨 ${criticalCount} are CRITICAL`;
  }
  if (highCount > 0) {
    summary += `, ⚠️  ${highCount} are HIGH`;
  }
  if (mediumCount > 0) {
    summary += `, ${mediumCount} are MEDIUM`;
  }

  summary += '.';

  return summary;
}

