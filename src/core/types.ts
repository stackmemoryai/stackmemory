export interface PersistenceAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  execute(query: string, params?: any[]): Promise<QueryResult>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  isConnected(): boolean;
}

export interface QueryResult {
  rows: any[];
  rowCount: number;
  fields?: Array<{
    name: string;
    type: string;
  }>;
}

export interface TraceData {
  id: string;
  sessionId: string;
  timestamp: Date;
  type: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface ContextData {
  id: string;
  projectId: string;
  branch?: string;
  content: string;
  timestamp: Date;
  type: string;
  metadata?: Record<string, any>;
}
