import { DEFAULT_CONFIG } from '../config.ts';
import type { AnalysisReport, Impact, RuleId } from '../types.ts';

type SarifLevel = 'error' | 'warning' | 'note';

interface SarifRule {
  id: RuleId;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
}

interface SarifResult {
  ruleId: RuleId;
  level: SarifLevel;
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
  'metric-cardinality',
  'queue-consumers',
  'error-swallowing',
  'http-handlers',
  'otel-naming',
];

function impactToSarifLevel(impact: Impact): SarifLevel {
  switch (impact) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
  }
}

export function buildSarifReport(report: AnalysisReport): SarifLog {
  const rules: SarifRule[] = RULE_IDS.map((id) => ({
    id,
    shortDescription: { text: DEFAULT_CONFIG.rules[id].description },
    defaultConfiguration: { level: impactToSarifLevel(DEFAULT_CONFIG.rules[id].impact) },
  }));

  const results: SarifResult[] = report.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: impactToSarifLevel(finding.impact),
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
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Telemetry PRs',
            version: '0.2.0',
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
