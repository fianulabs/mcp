import type { Env, SessionState, ToolHandler } from '../types';
import { ConsultaClient } from '../api/consulta-client';

/**
 * Data point in a compliance trend
 */
interface TrendDataPoint {
  date: string;
  score: number;
  passing: number;
  failing: number;
  total: number;
}

/**
 * Control-level change tracking
 */
interface ControlChange {
  controlPath: string;
  controlName: string;
  startScore: number;
  endScore: number;
  changePercent: number;
  direction: 'improved' | 'declined' | 'stable';
}

/**
 * Response from get_compliance_trends tool
 */
interface ComplianceTrendsResponse {
  summary: {
    currentScore: number;
    periodStartScore: number;
    trendDirection: 'improving' | 'stable' | 'declining';
    changePercent: number;
    periodLabel: string;
    confidence: 'high' | 'medium' | 'low';
  };
  highlights: {
    mostImproved: ControlChange[];
    mostDeclined: ControlChange[];
  };
  dataPoints: TrendDataPoint[];
  query: {
    assetIdentifier?: string;
    period: string;
    dataPointCount: number;
  };
  insights: string[];
  recommendations: string[];
}

/**
 * Calculate trend direction and statistics from data points
 */
function calculateTrend(dataPoints: TrendDataPoint[]): {
  direction: 'improving' | 'stable' | 'declining';
  changePercent: number;
  confidence: 'high' | 'medium' | 'low';
} {
  if (dataPoints.length < 2) {
    return { direction: 'stable', changePercent: 0, confidence: 'low' };
  }
  
  const startScore = dataPoints[0].score;
  const endScore = dataPoints[dataPoints.length - 1].score;
  const changePercent = startScore > 0 
    ? ((endScore - startScore) / startScore) * 100 
    : 0;
  
  // Determine direction with a 2% threshold for "stable"
  let direction: 'improving' | 'stable' | 'declining';
  if (changePercent > 2) {
    direction = 'improving';
  } else if (changePercent < -2) {
    direction = 'declining';
  } else {
    direction = 'stable';
  }
  
  // Confidence based on data point count and consistency
  let confidence: 'high' | 'medium' | 'low';
  if (dataPoints.length >= 7) {
    // Check for consistency in trend direction
    let consistentDirection = 0;
    for (let i = 1; i < dataPoints.length; i++) {
      const pointChange = dataPoints[i].score - dataPoints[i - 1].score;
      if ((direction === 'improving' && pointChange >= 0) ||
          (direction === 'declining' && pointChange <= 0) ||
          direction === 'stable') {
        consistentDirection++;
      }
    }
    const consistencyRatio = consistentDirection / (dataPoints.length - 1);
    confidence = consistencyRatio > 0.7 ? 'high' : consistencyRatio > 0.5 ? 'medium' : 'low';
  } else if (dataPoints.length >= 3) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  
  return { direction, changePercent: Math.round(changePercent * 10) / 10, confidence };
}

/**
 * Get period dates from period string
 */
function getPeriodDates(period: string): { startDate: Date; endDate: Date; label: string } {
  const endDate = new Date();
  let startDate: Date;
  let label: string;
  
  switch (period) {
    case '7d':
      startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      label = 'Last 7 days';
      break;
    case '30d':
      startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      label = 'Last 30 days';
      break;
    case '90d':
      startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
      label = 'Last 90 days';
      break;
    default:
      startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      label = 'Last 30 days';
  }
  
  return { startDate, endDate, label };
}

/**
 * Handler for the get_compliance_trends tool
 * 
 * This tool provides compliance trend analysis over time using smart sampling
 * to ensure fast responses even for large tenants.
 * 
 * Questions it answers:
 * - "How has compliance changed over the last 30 days?"
 * - "Is my compliance improving or declining?"
 * - "What controls have improved/declined the most?"
 */
export const getComplianceTrendsHandler: ToolHandler = async (
  args: Record<string, unknown>,
  env: Env,
  session: SessionState
): Promise<ComplianceTrendsResponse> => {
  const client = new ConsultaClient(env, session);
  const startTime = Date.now();
  
  const assetIdentifier = args.assetIdentifier as string | undefined;
  const period = (args.period as string) || '30d';
  
  console.log(`[get_compliance_trends] Starting: asset=${assetIdentifier || 'all'}, period=${period}`);
  
  const { startDate, endDate, label } = getPeriodDates(period);
  
  // Maximum data points we'll return (for response size and speed)
  const MAX_DATA_POINTS = 30;
  
  try {
    // Get trend data using smart sampling
    const trendData = await client.getComplianceTrendData({
      assetIdentifier,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      maxDataPoints: MAX_DATA_POINTS,
    });
    
    console.log(`[get_compliance_trends] Got ${trendData.dataPoints.length} data points in ${Date.now() - startTime}ms`);
    
    // Calculate overall trend
    const trend = calculateTrend(trendData.dataPoints);
    
    // Build response
    const dataPoints = trendData.dataPoints;
    const currentScore = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].score : 0;
    const periodStartScore = dataPoints.length > 0 ? dataPoints[0].score : 0;
    
    // Generate insights
    const insights: string[] = [];
    
    // Check actual data coverage
    let actualDataRange = '';
    if (dataPoints.length > 0) {
      const firstDate = dataPoints[0].date;
      const lastDate = dataPoints[dataPoints.length - 1].date;
      const requestedStart = startDate.toISOString().split('T')[0];
      
      // Check if data covers the full requested period
      if (firstDate > requestedStart) {
        const daysCovered = dataPoints.length;
        actualDataRange = `${firstDate} to ${lastDate}`;
        insights.push(`NOTE: Only ${daysCovered} days of data available (${actualDataRange}). Historical data before ${firstDate} not found.`);
      }
    }
    
    if (dataPoints.length === 0) {
      insights.push('No compliance data found for the specified period');
    } else {
      // Overall trend insight
      if (trend.direction === 'improving') {
        insights.push(`Compliance has improved ${Math.abs(trend.changePercent)}% over the available data period`);
      } else if (trend.direction === 'declining') {
        insights.push(`Compliance has declined ${Math.abs(trend.changePercent)}% over the available data period`);
      } else {
        insights.push(`Compliance has remained stable over the available data period`);
      }
      
      // Current score insight
      if (currentScore >= 90) {
        insights.push(`Current compliance score is excellent at ${currentScore.toFixed(1)}%`);
      } else if (currentScore >= 70) {
        insights.push(`Current compliance score is ${currentScore.toFixed(1)}% - room for improvement`);
      } else {
        insights.push(`Current compliance score of ${currentScore.toFixed(1)}% needs attention`);
      }
      
      // Data quality insight
      if (trend.confidence === 'high') {
        insights.push('Trend analysis has high confidence based on consistent data');
      } else if (trend.confidence === 'low') {
        insights.push('Limited data points - trend confidence is low');
      }
      
      // Control-level insights
      if (trendData.controlChanges.mostImproved.length > 0) {
        const top = trendData.controlChanges.mostImproved[0];
        insights.push(`Most improved control: ${top.controlName || top.controlPath} (+${Math.abs(top.changePercent).toFixed(1)}%)`);
      }
      
      if (trendData.controlChanges.mostDeclined.length > 0) {
        const worst = trendData.controlChanges.mostDeclined[0];
        insights.push(`Most declined control: ${worst.controlName || worst.controlPath} (${worst.changePercent.toFixed(1)}%)`);
      }
    }
    
    // Generate recommendations
    const recommendations: string[] = [];
    
    if (trend.direction === 'declining') {
      recommendations.push('Review failing controls to identify root causes of decline');
      recommendations.push('Use get_policy_violations to see current compliance failures');
    }
    
    if (trendData.controlChanges.mostDeclined.length > 0) {
      const worst = trendData.controlChanges.mostDeclined[0];
      recommendations.push(`Prioritize remediation of ${worst.controlName || worst.controlPath}`);
    }
    
    if (currentScore < 80) {
      recommendations.push('Use get_compliance_summary to identify high-impact remediation opportunities');
    }
    
    if (dataPoints.length < 7) {
      recommendations.push('More data needed for reliable trend analysis - check back in a few days');
    }
    
    const response: ComplianceTrendsResponse = {
      summary: {
        currentScore: Math.round(currentScore * 10) / 10,
        periodStartScore: Math.round(periodStartScore * 10) / 10,
        trendDirection: trend.direction,
        changePercent: trend.changePercent,
        periodLabel: label,
        confidence: trend.confidence,
      },
      highlights: {
        mostImproved: trendData.controlChanges.mostImproved.slice(0, 3),
        mostDeclined: trendData.controlChanges.mostDeclined.slice(0, 3),
      },
      dataPoints,
      query: {
        assetIdentifier,
        period,
        dataPointCount: dataPoints.length,
      },
      insights,
      recommendations,
    };
    
    console.log(`[get_compliance_trends] Completed in ${Date.now() - startTime}ms: ${trend.direction} (${trend.changePercent}%)`);
    
    // Return in MCP content format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }],
    } as any;
    
  } catch (error) {
    console.error(`[get_compliance_trends] Failed after ${Date.now() - startTime}ms:`, error);
    
    // Return error response in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Failed to retrieve compliance trends',
          message: error instanceof Error ? error.message : 'Unknown error',
          insights: ['Trend data could not be retrieved - try again or use get_compliance_summary for current status'],
          recommendations: ['Check if the asset identifier is correct', 'Try a shorter time period'],
        }, null, 2)
      }],
    } as any;
  }
};

