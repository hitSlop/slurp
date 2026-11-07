// Wire types come from slurp-api. Only UI concepts and JSON detail helpers live here.
export type {
  Value as Cell,
  TableSummary,
  Column,
  Input as DataInput,
  Warning as ModelWarning,
  QueryResult,
  Freshness as SourceFreshness,
  SourceSummary,
  SourceTable,
  ImportPreview,
  ImportSummary,
  Finding,
  Model,
  Layer as DataLayer,
  RawTable,
  SourceDescription,
  ImportRequest,
  ImportResult,
  OpenRequest as SourceViewDefinition,
  AggregateOp,
  Aggregate,
  ViewQuery,
  Presentation as ViewPresentation,
  SavedViewDefinition,
  Stored as SavedView,
  ViewMeta as SourceViewMeta,
  Window as SourceWindow,
  QueryRequest,
  ParamDef as ReportParam,
  Block as ReportBlock,
  ReportDefinition,
  StoredReport,
  ReportSummary,
  SlurpError as ErrorJson,
  ReportRun,
  ResolvedBlock,
  Revision,
  Problem,
  Activity,
  EngineLimits,
  HomeInfo,
  Project,
  ProjectDetail,
  SearchHit,
  Reference,
  ChatSummary,
  Message,
  ChatDetail,
  ChatList as ChatLists,
  Agent,
  DetectedAgent,
  CloudSettings,
  CloudLogin,
  SdkSetup,
  HostedSource,
  SdkSource,
  SendTestEventResult,
  SyncSourceResult,
  LibraryStatus,
  MaintenanceReport,
  MoveReport,
  FolderInspection,
} from './generated';

import type { Value as Cell } from './generated';
/** Optional display title attached to a reference chip by the UI. */
export type Ref = import('./generated').Chip & { title?: string };

export type SourceFormat =
  | 'csv'
  | 'json'
  | 'jsonl'
  | 'ndjson'
  | 'parquet'
  | 'xlsx'
  | 'sqlite'
  | 'duckdb'
  | 'folder'
  | 'model';

export interface ColumnProfile {
  stats_skipped?: 'nested' | 'text_over_1024_chars';
  approx?: true;
  top_values?: { value: Cell; count: number }[];
  numeric_like?: {
    castable_pct: number;
    non_numeric: { value: Cell; count: number }[];
  };
  date_like?: { castable_pct: number };
  empty_strings?: number;
  all_null?: true;
  candidate_key?: true;
  length?: { min: number; max: number; avg: number };
  quantiles?: {
    p0: number;
    p25: number;
    p50: number;
    p75: number;
    p100: number;
  };
  histogram?: { lo: number; hi: number; count: number }[];
  date?: {
    granularity: string;
    gaps: number;
  };
}

export interface Lineage {
  edges: { from: Ref; to: Ref }[];
}


export type ProjectColor =
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'blue'
  | 'violet'
  | 'pink'
  | 'gray';

export type RefKind = 'source' | 'model' | 'report' | 'project' | 'chat';

export interface DropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths: string[];
}

export type MenuAction =
  'about' | 'settings' | 'import' | 'library' | 'toggle_sidebar' | 'palette';

/** What only the native shell does; everything else is a slurpd op. */
export type NativeRequest =
  | { op: 'window_ready' }
  | { op: 'window_background'; color: string }
  | { op: 'pick_files' | 'pick_folder' | 'pick_image' }
  | {
      op: 'reveal';
      target: 'library' | 'source_file' | 'app_home';
      alias?: string;
    }
  | { op: 'open_external'; url: string };
