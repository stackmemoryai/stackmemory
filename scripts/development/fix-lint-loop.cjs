#!/usr/bin/env node
/**
 * Auto-fix lint errors in a loop until only warnings remain
 * Outputs detailed fix log for Claude to review
 */

const { execSync } = require('child_process');
const { writeFileSync } = require('fs');

const MAX_ATTEMPTS = 3;
let attempt = 0;
const fixLog = [];

function logFix(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message };
  fixLog.push(entry);
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
}

function saveLintReport(output, filename) {
  try {
    writeFileSync(filename, output);
    logFix(`Lint report saved to ${filename}`, 'info');
  } catch (err) {
    logFix(`Failed to save lint report: ${err.message}`, 'error');
  }
}

logFix('🔧 Starting auto-fix loop...');

while (attempt < MAX_ATTEMPTS) {
  attempt++;
  logFix(`📝 Auto-fix attempt ${attempt}/${MAX_ATTEMPTS}`);
  
  try {
    // Get initial errors for comparison
    let beforeOutput = '';
    try {
      execSync('npx eslint src/**/*.ts scripts/**/*.ts', { stdio: 'pipe' });
    } catch (beforeError) {
      beforeOutput = beforeError.stdout?.toString() || '';
      const errorCount = (beforeOutput.match(/\s+error\s+/g) || []).length;
      const warningCount = (beforeOutput.match(/\s+warning\s+/g) || []).length;
      logFix(`Found ${errorCount} errors, ${warningCount} warnings before auto-fix`);
    }
    
    // Try to fix what can be auto-fixed
    logFix('Running ESLint auto-fix...');
    try {
      execSync('npx eslint src/**/*.ts scripts/**/*.ts --fix', { 
        stdio: 'pipe' 
      });
    } catch (fixError) {
      // ESLint fix command can fail but still make fixes
      logFix('ESLint --fix completed (may have remaining issues)');
    }
    
    // Check results after fix
    let afterOutput = '';
    try {
      execSync('npx eslint src/**/*.ts scripts/**/*.ts --max-warnings 999', { 
        stdio: 'pipe' 
      });
      
      logFix('✅ All fixable lint errors resolved! (warnings are ok for commits)', 'success');
      saveLintReport(JSON.stringify(fixLog, null, 2), '.lint-fix-log.json');
      process.exit(0);
      
    } catch (afterError) {
      afterOutput = afterError.stdout?.toString() || '';
      const remainingErrors = (afterOutput.match(/\s+error\s+/g) || []).length;
      const remainingWarnings = (afterOutput.match(/\s+warning\s+/g) || []).length;
      logFix(`After auto-fix: ${remainingErrors} errors, ${remainingWarnings} warnings`);
    }
    
    // Check if only warnings remain
    if (!afterOutput.includes(' error ') && afterOutput.includes(' warning ')) {
      logFix('✅ Only warnings remain - allowing commit!', 'success');
      logFix('💡 Consider fixing warnings when convenient', 'info');
      saveLintReport(afterOutput, '.lint-warnings.log');
      saveLintReport(JSON.stringify(fixLog, null, 2), '.lint-fix-log.json');
      process.exit(0);
    }
    
    if (attempt === MAX_ATTEMPTS) {
      logFix(`❌ Could not auto-fix all errors after ${MAX_ATTEMPTS} attempts`, 'error');
      logFix('🚫 Blocking commit - errors require manual attention:', 'error');
      saveLintReport(afterOutput, '.lint-errors.log');
      saveLintReport(JSON.stringify(fixLog, null, 2), '.lint-fix-log.json');
      console.log('\n' + afterOutput);
      process.exit(1);
    } else {
      logFix(`⚠️ ${(afterOutput.match(/\s+error\s+/g) || []).length} errors remain, trying again...`, 'warn');
    }
    
  } catch (error) {
    logFix(`Unexpected error: ${error.message}`, 'error');
    if (attempt === MAX_ATTEMPTS) {
      process.exit(1);
    }
  }
}