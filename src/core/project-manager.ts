/**
 * Automatic Project Management for StackMemory
 * Auto-detects and organizes projects based on Git origins
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { logger } from './logger.js';

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  gitRemote?: string;
  organization?: string;
  accountType: 'personal' | 'work' | 'opensource' | 'client';
  isPrivate: boolean;
  primaryLanguage?: string;
  framework?: string;
  lastAccessed: Date;
  metadata: Record<string, any>;
}

export interface OrganizationConfig {
  name: string;
  type: 'company' | 'personal' | 'opensource' | 'client';
  domains: string[];
  githubOrgs: string[];
  gitlabGroups?: string[];
  bitbucketTeams?: string[];
  accountType: 'personal' | 'work' | 'opensource' | 'client';
  autoPatterns?: string[];
}

export class ProjectManager {
  private static instance: ProjectManager;
  private db: Database.Database;
  private configPath: string;
  private organizations: Map<string, OrganizationConfig> = new Map();
  private projectCache: Map<string, ProjectInfo> = new Map();
  private currentProject?: ProjectInfo;

  private constructor() {
    this.configPath = join(homedir(), '.stackmemory');
    this.ensureDirectoryStructure();
    this.initializeDatabase();
    this.loadOrganizations();
    this.autoDiscoverOrganizations();
  }

  static getInstance(): ProjectManager {
    if (!ProjectManager.instance) {
      ProjectManager.instance = new ProjectManager();
    }
    return ProjectManager.instance;
  }

  /**
   * Auto-detect project from current directory
   */
  async detectProject(projectPath?: string): Promise<ProjectInfo> {
    const path = projectPath || process.cwd();
    
    // Check cache first
    const cached = this.projectCache.get(path);
    if (cached && this.isCacheValid(cached)) {
      return cached;
    }

    const project = await this.analyzeProject(path);
    
    // Auto-categorize based on git origin
    if (project.gitRemote) {
      project.organization = this.extractOrganization(project.gitRemote);
      project.accountType = this.determineAccountType(project.gitRemote, project.organization);
      project.isPrivate = this.isPrivateRepo(project.gitRemote);
    }

    // Detect framework and language
    project.primaryLanguage = this.detectPrimaryLanguage(path);
    project.framework = this.detectFramework(path);

    // Store in database
    this.saveProject(project);
    this.projectCache.set(path, project);
    this.currentProject = project;

    logger.info('Project auto-detected', {
      id: project.id,
      org: project.organization,
      type: project.accountType
    });

    return project;
  }

  /**
   * Analyze project directory
   */
  private async analyzeProject(projectPath: string): Promise<ProjectInfo> {
    const gitInfo = this.getGitInfo(projectPath);
    const projectName = gitInfo.name || basename(projectPath);
    
    return {
      id: this.generateProjectId(gitInfo.remote || projectPath),
      name: projectName,
      path: projectPath,
      gitRemote: gitInfo.remote,
      organization: undefined,
      accountType: 'personal',
      isPrivate: false,
      lastAccessed: new Date(),
      metadata: {
        branch: gitInfo.branch,
        lastCommit: gitInfo.lastCommit,
        isDirty: gitInfo.isDirty
      }
    };
  }

  /**
   * Extract Git information
   */
  private getGitInfo(projectPath: string): any {
    const info: any = {};
    
    try {
      // Get remote origin
      info.remote = execSync('git config --get remote.origin.url', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      // Get current branch
      info.branch = execSync('git branch --show-current', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      // Get last commit
      info.lastCommit = execSync('git log -1 --format=%H', {
        cwd: projectPath,
        encoding: 'utf-8'
      }).trim();

      // Check if working tree is dirty
      const status = execSync('git status --porcelain', {
        cwd: projectPath,
        encoding: 'utf-8'
      });
      info.isDirty = status.length > 0;

      // Extract project name from remote
      const match = info.remote.match(/\/([^\/]+?)(\.git)?$/);
      info.name = match ? match[1] : basename(projectPath);

    } catch (error) {
      // Not a git repository or git not available
      info.name = basename(projectPath);
    }

    return info;
  }

  /**
   * Extract organization from Git remote
   */
  private extractOrganization(gitRemote: string): string {
    // GitHub: git@github.com:org/repo.git or https://github.com/org/repo
    const githubMatch = gitRemote.match(/github\.com[:/]([^/]+)\//);
    if (githubMatch) return githubMatch[1];

    // GitLab: git@gitlab.com:org/repo.git
    const gitlabMatch = gitRemote.match(/gitlab\.com[:/]([^/]+)\//);
    if (gitlabMatch) return gitlabMatch[1];

    // Bitbucket: git@bitbucket.org:org/repo.git
    const bitbucketMatch = gitRemote.match(/bitbucket\.org[:/]([^/]+)\//);
    if (bitbucketMatch) return bitbucketMatch[1];

    // Custom domain: git@git.company.com:team/repo.git
    const customMatch = gitRemote.match(/@([^:]+)[:/]([^/]+)\//);
    if (customMatch) return customMatch[2];

    return 'unknown';
  }

  /**
   * Determine account type based on patterns
   */
  private determineAccountType(
    gitRemote: string,
    organization?: string
  ): 'personal' | 'work' | 'opensource' | 'client' {
    // Check against known organizations
    for (const [, org] of this.organizations) {
      if (org.githubOrgs.includes(organization || '')) {
        return org.accountType;
      }
      
      // Check if remote matches any known domain
      for (const domain of org.domains) {
        if (gitRemote.includes(domain)) {
          return org.accountType;
        }
      }
    }

    // Auto-detection heuristics
    if (organization) {
      // Common work patterns
      if (organization.includes('corp') || organization.includes('company') ||
          organization.includes('team') || organization.includes('work')) {
        return 'work';
      }

      // Common opensource patterns  
      if (organization.includes('apache') || organization.includes('mozilla') ||
          organization.includes('foundation') || gitRemote.includes('gitlab.freedesktop')) {
        return 'opensource';
      }

      // Check if it's the user's own org
      const username = this.getCurrentGitUser();
      if (username && organization.toLowerCase() === username.toLowerCase()) {
        return 'personal';
      }
    }

    // Check if it's a private repo (likely work or personal)
    if (this.isPrivateRepo(gitRemote)) {
      // Use additional heuristics
      const currentPath = process.cwd();
      if (currentPath.includes('/work/') || currentPath.includes('/Work/') ||
          currentPath.includes('/company/') || currentPath.includes('/job/')) {
        return 'work';
      }
    }

    return 'personal';
  }

  /**
   * Check if repository is private
   */
  private isPrivateRepo(gitRemote: string): boolean {
    // SSH URLs are typically private
    if (gitRemote.startsWith('git@')) {
      return true;
    }

    // HTTPS with credentials
    if (gitRemote.includes('@')) {
      return true;
    }

    // Try to check GitHub API (requires authentication for private repos)
    // This is a simplified check
    return false;
  }

  /**
   * Detect primary programming language
   */
  private detectPrimaryLanguage(projectPath: string): string | undefined {
    const checks = [
      { file: 'package.json', language: 'JavaScript/TypeScript' },
      { file: 'Cargo.toml', language: 'Rust' },
      { file: 'go.mod', language: 'Go' },
      { file: 'pom.xml', language: 'Java' },
      { file: 'requirements.txt', language: 'Python' },
      { file: 'Gemfile', language: 'Ruby' },
      { file: 'composer.json', language: 'PHP' },
      { file: '*.csproj', language: 'C#' },
      { file: 'Podfile', language: 'Swift/Objective-C' }
    ];

    for (const check of checks) {
      if (check.file.includes('*')) {
        // Glob pattern
        try {
          const files = execSync(`find ${projectPath} -maxdepth 2 -name "${check.file}" 2>/dev/null`, {
            encoding: 'utf-8'
          });
          if (files.trim()) return check.language;
        } catch {}
      } else if (existsSync(join(projectPath, check.file))) {
        return check.language;
      }
    }

    return undefined;
  }

  /**
   * Detect framework
   */
  private detectFramework(projectPath: string): string | undefined {
    const packageJsonPath = join(projectPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        // Check for common frameworks
        if (deps['next']) return 'Next.js';
        if (deps['react']) return 'React';
        if (deps['vue']) return 'Vue';
        if (deps['@angular/core']) return 'Angular';
        if (deps['express']) return 'Express';
        if (deps['fastify']) return 'Fastify';
        if (deps['@nestjs/core']) return 'NestJS';
      } catch {}
    }

    // Check for other framework indicators
    if (existsSync(join(projectPath, 'Cargo.toml'))) {
      const cargo = readFileSync(join(projectPath, 'Cargo.toml'), 'utf-8');
      if (cargo.includes('actix-web')) return 'Actix';
      if (cargo.includes('rocket')) return 'Rocket';
    }

    return undefined;
  }

  /**
   * Get current Git user
   */
  private getCurrentGitUser(): string | undefined {
    try {
      const email = execSync('git config --global user.email', {
        encoding: 'utf-8'
      }).trim();
      
      const username = email.split('@')[0];
      return username;
    } catch {
      return undefined;
    }
  }

  /**
   * Generate unique project ID
   */
  private generateProjectId(identifier: string): string {
    // Create a stable ID from the git remote or path
    const cleaned = identifier
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .toLowerCase();
    
    return cleaned.substring(cleaned.length - 50); // Last 50 chars
  }

  /**
   * Initialize database
   */
  private initializeDatabase(): void {
    const dbPath = join(this.configPath, 'projects.db');
    this.db = new Database(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        git_remote TEXT,
        organization TEXT,
        account_type TEXT,
        is_private BOOLEAN,
        primary_language TEXT,
        framework TEXT,
        last_accessed DATETIME,
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS organizations (
        name TEXT PRIMARY KEY,
        type TEXT,
        account_type TEXT,
        config JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS project_contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        context_type TEXT,
        content TEXT,
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization);
      CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(account_type);
      CREATE INDEX IF NOT EXISTS idx_contexts_project ON project_contexts(project_id);
    `);
  }

  /**
   * Save project to database
   */
  private saveProject(project: ProjectInfo): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO projects 
      (id, name, path, git_remote, organization, account_type, is_private, 
       primary_language, framework, last_accessed, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      project.id,
      project.name,
      project.path,
      project.gitRemote,
      project.organization,
      project.accountType,
      project.isPrivate ? 1 : 0,
      project.primaryLanguage,
      project.framework,
      project.lastAccessed.toISOString(),
      JSON.stringify(project.metadata)
    );
  }

  /**
   * Load organizations configuration
   */
  private loadOrganizations(): void {
    const configFile = join(this.configPath, 'organizations.json');
    
    if (existsSync(configFile)) {
      try {
        const config = JSON.parse(readFileSync(configFile, 'utf-8'));
        for (const org of config.organizations || []) {
          this.organizations.set(org.name, org);
        }
      } catch (error) {
        logger.error('Failed to load organizations config', error);
      }
    }
  }

  /**
   * Auto-discover organizations from existing projects
   */
  private autoDiscoverOrganizations(): void {
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT organization, account_type, COUNT(*) as project_count
        FROM projects
        WHERE organization IS NOT NULL
        GROUP BY organization, account_type
      `);

      const orgs = stmt.all() as any[];
      
      for (const org of orgs) {
        if (!this.organizations.has(org.organization)) {
          // Auto-create organization config
          this.organizations.set(org.organization, {
            name: org.organization,
            type: org.account_type === 'work' ? 'company' : 'personal',
            domains: [],
            githubOrgs: [org.organization],
            accountType: org.account_type,
            autoPatterns: []
          });
        }
      }
    } catch (error) {
      logger.error('Failed to auto-discover organizations', error);
    }
  }

  /**
   * Ensure directory structure exists
   */
  private ensureDirectoryStructure(): void {
    const dirs = [
      this.configPath,
      join(this.configPath, 'accounts'),
      join(this.configPath, 'accounts', 'personal'),
      join(this.configPath, 'accounts', 'work'),
      join(this.configPath, 'accounts', 'opensource'),
      join(this.configPath, 'accounts', 'client'),
      join(this.configPath, 'contexts'),
      join(this.configPath, 'patterns')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Check if cache is still valid
   */
  private isCacheValid(project: ProjectInfo): boolean {
    const cacheAge = Date.now() - project.lastAccessed.getTime();
    return cacheAge < 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get all projects
   */
  getAllProjects(): ProjectInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM projects
      ORDER BY last_accessed DESC
    `);

    const projects = stmt.all() as any[];
    return projects.map(p => ({
      ...p,
      isPrivate: p.is_private === 1,
      lastAccessed: new Date(p.last_accessed),
      metadata: JSON.parse(p.metadata || '{}')
    }));
  }

  /**
   * Get projects by organization
   */
  getProjectsByOrganization(organization: string): ProjectInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM projects
      WHERE organization = ?
      ORDER BY last_accessed DESC
    `);

    const projects = stmt.all(organization) as any[];
    return projects.map(p => ({
      ...p,
      isPrivate: p.is_private === 1,
      lastAccessed: new Date(p.last_accessed),
      metadata: JSON.parse(p.metadata || '{}')
    }));
  }

  /**
   * Get projects by account type
   */
  getProjectsByAccountType(accountType: string): ProjectInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM projects
      WHERE account_type = ?
      ORDER BY last_accessed DESC
    `);

    const projects = stmt.all(accountType) as any[];
    return projects.map(p => ({
      ...p,
      isPrivate: p.is_private === 1,
      lastAccessed: new Date(p.last_accessed),
      metadata: JSON.parse(p.metadata || '{}')
    }));
  }

  /**
   * Get current project
   */
  getCurrentProject(): ProjectInfo | undefined {
    if (!this.currentProject) {
      this.detectProject();
    }
    return this.currentProject;
  }

  /**
   * Save organization config
   */
  saveOrganization(org: OrganizationConfig): void {
    this.organizations.set(org.name, org);
    
    // Save to file
    const configFile = join(this.configPath, 'organizations.json');
    const config = {
      organizations: Array.from(this.organizations.values())
    };
    
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    
    // Save to database
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO organizations (name, type, account_type, config)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(org.name, org.type, org.accountType, JSON.stringify(org));
  }

  /**
   * Auto-categorize all Git repositories in home directory
   */
  async scanAndCategorizeAllProjects(basePaths?: string[]): Promise<void> {
    const paths = basePaths || [
      join(homedir(), 'Dev'),
      join(homedir(), 'dev'),
      join(homedir(), 'Projects'),
      join(homedir(), 'projects'),
      join(homedir(), 'Work'),
      join(homedir(), 'work'),
      join(homedir(), 'Documents/GitHub'),
      join(homedir(), 'code')
    ];

    logger.info('Scanning for Git repositories...');

    for (const basePath of paths) {
      if (!existsSync(basePath)) continue;
      
      try {
        // Find all .git directories
        const gitDirs = execSync(
          `find ${basePath} -type d -name .git -maxdepth 4 2>/dev/null`,
          { encoding: 'utf-8' }
        ).trim().split('\n').filter(Boolean);

        for (const gitDir of gitDirs) {
          const projectPath = dirname(gitDir);
          
          try {
            await this.detectProject(projectPath);
            logger.info(`Discovered project: ${projectPath}`);
          } catch (error) {
            logger.warn(`Failed to analyze project: ${projectPath}`, error);
          }
        }
      } catch (error) {
        logger.warn(`Failed to scan ${basePath}`, error);
      }
    }

    logger.info(`Scan complete. Found ${this.projectCache.size} projects`);
  }

  /**
   * Generate summary report
   */
  generateReport(): string {
    const allProjects = this.getAllProjects();
    
    const report = {
      total: allProjects.length,
      byAccountType: {} as Record<string, number>,
      byOrganization: {} as Record<string, number>,
      byLanguage: {} as Record<string, number>,
      byFramework: {} as Record<string, number>
    };

    for (const project of allProjects) {
      // Count by account type
      report.byAccountType[project.accountType] = 
        (report.byAccountType[project.accountType] || 0) + 1;
      
      // Count by organization
      if (project.organization) {
        report.byOrganization[project.organization] = 
          (report.byOrganization[project.organization] || 0) + 1;
      }
      
      // Count by language
      if (project.primaryLanguage) {
        report.byLanguage[project.primaryLanguage] = 
          (report.byLanguage[project.primaryLanguage] || 0) + 1;
      }
      
      // Count by framework
      if (project.framework) {
        report.byFramework[project.framework] = 
          (report.byFramework[project.framework] || 0) + 1;
      }
    }

    return JSON.stringify(report, null, 2);
  }
}