import { DEFAULT_CONFIG } from '../config.ts';
import type { AnalysisReport, RuleId } from '../types.ts';

interface SarifRule {
  id: RuleId;
  shortDescription: { text: string };
  defaultConfiguration: { level: 'error' | 'warning' };
}

interface SarifResult {
  ruleId: RuleId;
  level: 'error' | 'warning';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; endLine: number };
    };
  }>;
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }>;
}

const RULE_IDS: RuleId[] = [
  'http-handlers',
  'queue-consumers',
  'error-swallowing',
  'otel-naming',
];

export function buildSarifReport(report: AnalysisReport): SarifLog {
  const rules: SarifRule[] = RULE_IDS.map((id) => ({
    id,
    shortDescription: { text: DEFAULT_CONFIG.rules[id].description },
    defaultConfiguration: { level: DEFAULT_CONFIG.rules[id].severity },
  }));

  const results: SarifResult[] = report.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: finding.severity,
    message: { text: `${finding.message} ${finding.suggestion}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.filePath.replace(/^\/+/, '') },
          region: {
            startLine: finding.line,
            endLine: Math.max(finding.line, finding.endLine),
          },
        },
      },
    ],
  }));

  return {
    $schema:
      'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Telemetry PRs',
            version: '0.1.0',
            informationUri: 'https://github.com/telemetry-prs/telemetry-prs',
            rules,
          },
        },
        results,
      },
    ],
  };
}

export function formatSarifReport(report: AnalysisReport): string {
  return JSON.stringify(buildSarifReport(report), null, 2);
}
