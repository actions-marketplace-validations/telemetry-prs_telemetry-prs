export type CheckMode = 'comment' | 'fail';

export type Impact = 'high' | 'medium' | 'low';

export type BlockOn = 'none' | Impact;

export type RuleId =
  | 'http-handlers'
  | 'queue-consumers'
  | 'error-swallowing'
  | 'otel-naming'
  | 'metric-cardinality';

export type SignalKind = 'span' | 'span-error' | 'metric' | 'log';

export type MatchMode = 'any' | 'all';

export type SpanNameIssue = 'high-cardinality' | 'empty-name' | 'generic-name';

export interface TelemetryPatterns {
  spans: string[];
  spanErrors: string[];
  metrics: string[];
  logs: string[];
}

export interface RuleConfig {
  enabled: boolean;
  impact: Impact;
  require: SignalKind[];
  matchMode: MatchMode;
  minLines: number;
  description: string;
}

export interface TelemetryConfig {
  version: 1;
  blockOn: BlockOn;
  include: string[];
  exclude: string[];
  telemetry: TelemetryPatterns;
  rules: Record<RuleId, RuleConfig>;
}

export interface DiffFile {
  filePath: string;
  addedLines: Set<number>;
}

export interface CodeUnit {
  ruleId: RuleId;
  kind:
    | 'http-handler'
    | 'queue-consumer'
    | 'catch-block'
    | 'span-name'
    | 'metric-cardinality';
  symbolName: string;
  framework: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  ignored: boolean;
  foundSignals: SignalKind[];
  rethrows?: boolean;
  spanNameIssue?: SpanNameIssue;
  spanNameRaw?: string;
  cardinalityLabels?: string[];
  cardinalityValues?: string[];
}

export interface Finding {
  filePath: string;
  line: number;
  endLine: number;
  ruleId: RuleId;
  impact: Impact;
  kind: CodeUnit['kind'];
  symbolName: string;
  framework: string;
  requiredSignals: SignalKind[];
  matchMode: MatchMode;
  foundSignals: SignalKind[];
  missingSignals: SignalKind[];
  message: string;
  suggestion: string;
}

export interface RepoTelemetryStatus {
  checkedManifests: number;
  detectedSdks: string[];
  hasWranglerConfig: boolean;
  hasAnySdk: boolean;
}

export interface AnalysisReport {
  checkedFiles: number;
  checkedUnits: number;
  passedUnits: number;
  coveragePercent: number;
  findings: Finding[];
  highImpactCount: number;
  mediumImpactCount: number;
  lowImpactCount: number;
  repoTelemetry?: RepoTelemetryStatus;
}
