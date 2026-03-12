// Database operation with no error handling — needs StackMemory error wrapping

interface Frame {
  id: string;
  name: string;
  status: string;
}

// Simulated database
const db = {
  prepare(_sql: string) {
    return {
      get(..._params: unknown[]): Frame | undefined {
        // May throw: SQLITE_BUSY, SQLITE_CONSTRAINT, SQLITE_CORRUPT
        throw new Error('SQLITE_BUSY: database is locked');
      },
      run(..._params: unknown[]) {
        // May throw various SQLite errors
      },
    };
  },
};

// This function has NO error handling. Wrap it properly using:
// - DatabaseError from core/errors
// - Appropriate ErrorCode (DB_QUERY_FAILED, DB_CONNECTION_FAILED)
// - Preserve the original error as cause
// - Set isRetryable = true for connection/busy errors, false for constraint errors
// - Log with structured context (operation name, frameId)
async function getFrameById(frameId: string): Promise<Frame | null> {
  const row = db.prepare('SELECT * FROM frames WHERE id = ?').get(frameId);
  return row || null;
}

async function updateFrameStatus(
  frameId: string,
  status: string
): Promise<void> {
  db.prepare('UPDATE frames SET status = ? WHERE id = ?').run(status, frameId);
}

export { getFrameById, updateFrameStatus };
