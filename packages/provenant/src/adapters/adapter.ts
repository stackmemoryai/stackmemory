export interface RawRecord {
  external_id: string;
  content: string;
  raw_payload: string;
  actor?: string;
  created_at?: number; // unix ms in source system
  metadata?: Record<string, unknown>;
}

export interface SignalWeight {
  name: string;
  weight: number;
  detect: (record: RawRecord) => boolean;
}

export interface SourceAdapter {
  /** Unique system identifier, e.g. "linear", "slack", "github" */
  system: string;

  /** Fetch records changed since the given date */
  fetch(since: Date): Promise<RawRecord[]>;

  /** Source-specific confidence signal weights */
  signalModel: SignalWeight[];

  /** Compute a content hash for change detection */
  hashRecord(record: RawRecord): string;
}
