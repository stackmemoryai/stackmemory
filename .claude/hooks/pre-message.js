#!/usr/bin/env node
/**
 * Pre-message hook for Claude Code
 * Automatically retrieves relevant context before processing
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const userMessage = process.env.USER_MESSAGE || '';

// Initialize database
const dbPath = path.join(projectRoot, '.stackmemory', 'context.db');
if (!fs.existsSync(dbPath)) {
  // StackMemory not initialized, exit silently
  process.exit(0);
}

const db = new Database(dbPath);

// Extract intent from user message
function extractIntent(message) {
  const keywords = message.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  return keywords.slice(0, 5).join(' ');
}

// Get relevant contexts
function getRelevantContexts(query, limit = 5) {
  // First, try to find directly relevant contexts
  const contexts = db.prepare(`
    SELECT id, type, content, importance
    FROM contexts
    WHERE content LIKE ?
    ORDER BY importance DESC
    LIMIT ?
  `).all(`%${query}%`, limit);

  // If no direct matches, get top importance contexts
  if (contexts.length === 0) {
    return db.prepare(`
      SELECT id, type, content, importance
      FROM contexts
      ORDER BY importance DESC, last_accessed DESC
      LIMIT ?
    `).all(limit);
  }

  return contexts;
}

// Update access tracking
function trackAccess(contextIds) {
  const updateStmt = db.prepare(`
    UPDATE contexts 
    SET last_accessed = ?, access_count = access_count + 1
    WHERE id = ?
  `);

  const now = Math.floor(Date.now() / 1000);
  contextIds.forEach(id => {
    updateStmt.run(now, id);
  });
}

// Main execution
try {
  const intent = extractIntent(userMessage);
  const contexts = getRelevantContexts(intent);
  
  if (contexts.length > 0) {
    // Track that these contexts were accessed
    trackAccess(contexts.map(c => c.id));
    
    // Output context to be injected
    console.log('=== Project Context ===');
    contexts.forEach(ctx => {
      const importance = '●'.repeat(Math.round(ctx.importance * 5));
      console.log(`[${ctx.type.toUpperCase()}] ${importance}`);
      console.log(ctx.content);
      console.log('---');
    });
    
    // Log for attention tracking
    db.prepare(`
      INSERT INTO attention_log (query, response)
      VALUES (?, ?)
    `).run(userMessage, JSON.stringify(contexts));
  }
} catch (error) {
  // Fail silently to not interrupt Claude
  console.error('StackMemory hook error:', error.message);
}

db.close();