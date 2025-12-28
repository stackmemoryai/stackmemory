#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALIAS_NAME = 'claude-sm';
const WRAPPER_SCRIPT = 'claude-code-wrapper.sh';

function getShellConfigFiles() {
  const shell = process.env.SHELL || '';
  const home = os.homedir();
  const files = [];
  
  if (shell.includes('zsh')) {
    files.push(path.join(home, '.zshrc'));
    // Also check .zprofile for some systems
    const zprofile = path.join(home, '.zprofile');
    if (fs.existsSync(zprofile)) {
      files.push(zprofile);
    }
  }
  
  if (shell.includes('bash') || !shell.includes('zsh')) {
    const profilePath = path.join(home, '.bash_profile');
    const rcPath = path.join(home, '.bashrc');
    if (fs.existsSync(profilePath)) files.push(profilePath);
    if (fs.existsSync(rcPath)) files.push(rcPath);
  }
  
  if (shell.includes('fish')) {
    files.push(path.join(home, '.config', 'fish', 'config.fish'));
  }
  
  return files.length > 0 ? files : [path.join(home, '.bashrc')];
}

function setupAlias() {
  try {
    const wrapperPath = join(dirname(__dirname), 'scripts', WRAPPER_SCRIPT);
    
    if (!fs.existsSync(wrapperPath)) {
      console.log(`⚠️  Wrapper script not found at ${wrapperPath}`);
      console.log('   Please ensure claude-code-wrapper.sh exists in the scripts directory');
      return;
    }
    
    const configFiles = getShellConfigFiles();
    const aliasLine = `alias ${ALIAS_NAME}="${wrapperPath}"`;
    const marker = '# StackMemory Claude alias';
    let alreadyConfigured = false;
    let configuredIn = [];
    
    for (const configFile of configFiles) {
      let config = '';
      if (fs.existsSync(configFile)) {
        config = fs.readFileSync(configFile, 'utf8');
      }
      
      // Check if already has the alias (with marker or just the alias itself)
      if (config.includes(marker) || config.includes(`alias ${ALIAS_NAME}=`)) {
        configuredIn.push(configFile);
        alreadyConfigured = true;
        continue;
      }
      
      // Only add to primary shell config (first in the list)
      if (configuredIn.length === 0 && configFiles.indexOf(configFile) === 0) {
        const aliasBlock = `\n${marker}\n${aliasLine}\n`;
        fs.appendFileSync(configFile, aliasBlock);
        configuredIn.push(configFile);
        console.log(`✅ Added ${ALIAS_NAME} alias to ${configFile}`);
      }
    }
    
    if (alreadyConfigured && configuredIn.length > 0) {
      console.log(`✓ ${ALIAS_NAME} alias already configured in: ${configuredIn.join(', ')}`);
    } else if (configuredIn.length > 0) {
      console.log(`   Run 'source ${configuredIn[0]}' or restart your terminal to use it`);
      console.log(`   You can then use: ${ALIAS_NAME} [your message]`);
    }
    
  } catch (error) {
    console.error('Error setting up alias:', error.message);
    console.log('\nManual setup:');
    console.log(`Add this line to your shell config file:`);
    console.log(`alias ${ALIAS_NAME}="${join(dirname(__dirname), 'scripts', WRAPPER_SCRIPT)}"`);
  }
}

if (process.argv.includes('--check')) {
  const configFiles = getShellConfigFiles();
  let found = false;
  
  for (const configFile of configFiles) {
    if (fs.existsSync(configFile)) {
      const config = fs.readFileSync(configFile, 'utf8');
      if (config.includes(`alias ${ALIAS_NAME}=`)) {
        console.log(`✓ ${ALIAS_NAME} alias is configured in ${configFile}`);
        found = true;
        break;
      }
    }
  }
  
  if (!found) {
    console.log(`✗ ${ALIAS_NAME} alias not found`);
    process.exit(1);
  }
  process.exit(0);
}

setupAlias();