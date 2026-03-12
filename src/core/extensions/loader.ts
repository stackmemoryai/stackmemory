/**
 * Extension Loader
 * Supports loading extensions from multiple sources: URL, file, and NPM
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../monitoring/logger.js';
import { _ValidationError, _ErrorCode } from '../errors/index.js';
import type {
  Extension,
  ExtensionContext,
  ExtensionLoadOptions,
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionSourceType,
  ExtensionState,
  ExtensionValidationResult,
  EventHandler,
} from './types.js';

/**
 * Default load timeout in milliseconds
 */
const DEFAULT_LOAD_TIMEOUT = 30000;

/**
 * Maximum allowed permissions for security
 */
const ALLOWED_PERMISSION_PATTERNS: RegExp[] = [
  /^network:[a-z0-9.-]+$/,
  /^storage:(local|session)$/,
  /^frames:(read|write)$/,
  /^events:(emit|listen)$/,
];

/**
 * Blocked network domains for security
 */
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '*.local',
  'internal.*',
];

/**
 * Extension Loader class
 * Handles loading, validation, and lifecycle management of extensions
 */
export class ExtensionLoader {
  private loadedExtensions = new Map<string, ExtensionState>();
  private extensionInstances = new Map<string, Extension>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private grantedPermissions = new Map<string, Set<ExtensionPermission>>();

  /**
   * Load an extension from various sources
   */
  async loadExtension(
    options: ExtensionLoadOptions
  ): Promise<ExtensionLoadResult> {
    const { source, timeout = DEFAULT_LOAD_TIMEOUT } = options;

    try {
      // Parse source type
      const { type, uri } = this.parseSource(source);

      logger.info('Loading extension', { source, type });

      // Load with timeout
      const loadPromise = this.loadFromSource(type, uri, options);
      const result = await this.withTimeout(loadPromise, timeout);

      if (!result.success || !result.extension) {
        return result;
      }

      // Validate extension
      const validation = this.validateExtension(result.extension);
      if (!validation.valid) {
        return {
          success: false,
          error: `Extension validation failed: ${validation.errors.join(', ')}`,
          warnings: validation.warnings,
        };
      }

      // Verify permissions
      if (!options.skipPermissionCheck) {
        const permissionCheck = await this.verifyPermissions(
          result.extension,
          options.permissions
        );
        if (!permissionCheck.success) {
          return permissionCheck;
        }
      }

      // Initialize extension
      const initResult = await this.initializeExtension(
        result.extension,
        options
      );
      if (!initResult.success) {
        return initResult;
      }

      // Register extension
      const extensionId = this.generateExtensionId(result.extension);
      this.registerExtension(
        extensionId,
        result.extension,
        source,
        type,
        options
      );

      logger.info('Extension loaded successfully', {
        extensionId,
        name: result.extension.name,
        version: result.extension.version,
      });

      return {
        success: true,
        extension: result.extension,
        extensionId,
        warnings: validation.warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to load extension', { source, error: message });
      return {
        success: false,
        error: `Failed to load extension: ${message}`,
      };
    }
  }

  /**
   * Unload an extension
   */
  async unloadExtension(extensionId: string): Promise<boolean> {
    const extension = this.extensionInstances.get(extensionId);
    const state = this.loadedExtensions.get(extensionId);

    if (!extension || !state) {
      logger.warn('Extension not found for unload', { extensionId });
      return false;
    }

    try {
      // Call destroy lifecycle method
      await extension.destroy();

      // Clean up
      this.extensionInstances.delete(extensionId);
      this.loadedExtensions.delete(extensionId);
      this.grantedPermissions.delete(extensionId);

      logger.info('Extension unloaded', { extensionId });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to unload extension', {
        extensionId,
        error: message,
      });
      return false;
    }
  }

  /**
   * Get all loaded extensions
   */
  getLoadedExtensions(): ExtensionState[] {
    return Array.from(this.loadedExtensions.values());
  }

  /**
   * Get extension by ID
   */
  getExtension(extensionId: string): Extension | undefined {
    return this.extensionInstances.get(extensionId);
  }

  /**
   * Get extension state by ID
   */
  getExtensionState(extensionId: string): ExtensionState | undefined {
    return this.loadedExtensions.get(extensionId);
  }

  /**
   * Parse source string to determine type and URI
   */
  private parseSource(source: string): {
    type: ExtensionSourceType;
    uri: string;
  } {
    if (source.startsWith('https://') || source.startsWith('http://')) {
      return { type: 'url', uri: source };
    }

    if (source.startsWith('file://')) {
      return { type: 'file', uri: source.slice(7) };
    }

    if (source.startsWith('npm:')) {
      return { type: 'npm', uri: source.slice(4) };
    }

    // Default: treat as file path if it looks like a path
    if (
      source.startsWith('/') ||
      source.startsWith('./') ||
      source.startsWith('../')
    ) {
      return { type: 'file', uri: source };
    }

    // Otherwise assume npm package
    return { type: 'npm', uri: source };
  }

  /**
   * Load extension from source based on type
   */
  private async loadFromSource(
    type: ExtensionSourceType,
    uri: string,
    _options: ExtensionLoadOptions
  ): Promise<ExtensionLoadResult> {
    switch (type) {
      case 'url':
        return this.loadFromUrl(uri);
      case 'file':
        return this.loadFromFile(uri);
      case 'npm':
        return this.loadFromNpm(uri);
      default:
        return {
          success: false,
          error: `Unknown source type: ${type}`,
        };
    }
  }

  /**
   * Load extension from URL
   */
  private async loadFromUrl(url: string): Promise<ExtensionLoadResult> {
    try {
      // Validate URL
      const parsedUrl = new URL(url);

      // Security check: block internal URLs
      if (this.isBlockedDomain(parsedUrl.hostname)) {
        return {
          success: false,
          error: `Blocked domain: ${parsedUrl.hostname}`,
        };
      }

      // Only allow HTTPS in production
      if (
        parsedUrl.protocol !== 'https:' &&
        process.env['NODE_ENV'] === 'production'
      ) {
        return {
          success: false,
          error: 'Only HTTPS URLs are allowed in production',
        };
      }

      // Fetch extension code
      const response = await fetch(url);
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const code = await response.text();

      // Try to load manifest from adjacent file
      const manifestUrl = url.replace(/\.js$/, '.manifest.json');
      let manifest: ExtensionManifest | undefined;

      try {
        const manifestResponse = await fetch(manifestUrl);
        if (manifestResponse.ok) {
          manifest = await manifestResponse.json();
        }
      } catch {
        // Manifest is optional for URL sources
      }

      // Dynamic import via data URL
      const extension = await this.evaluateExtensionCode(code, url);
      if (manifest) {
        extension.manifest = manifest;
      }

      return { success: true, extension };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to load from URL: ${message}`,
      };
    }
  }

  /**
   * Load extension from local file
   */
  private async loadFromFile(filePath: string): Promise<ExtensionLoadResult> {
    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);

      // Check file exists
      try {
        await fs.access(absolutePath);
      } catch {
        return {
          success: false,
          error: `File not found: ${absolutePath}`,
        };
      }

      // Load manifest if present
      const manifestPath = absolutePath.replace(/\.js$/, '.manifest.json');
      let manifest: ExtensionManifest | undefined;

      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(manifestContent);
      } catch {
        // Try package.json in same directory
        try {
          const packagePath = path.join(
            path.dirname(absolutePath),
            'package.json'
          );
          const packageContent = await fs.readFile(packagePath, 'utf-8');
          const pkg = JSON.parse(packageContent);
          if (pkg.stackmemory) {
            manifest = pkg.stackmemory;
          }
        } catch {
          // No manifest found
        }
      }

      // Dynamic import
      const fileUrl = pathToFileURL(absolutePath).href;
      const module = await import(fileUrl);
      const extension = module.default || module;

      if (!this.isExtensionLike(extension)) {
        return {
          success: false,
          error: 'Module does not export a valid extension',
        };
      }

      if (manifest) {
        extension.manifest = manifest;
      }

      return { success: true, extension };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to load from file: ${message}`,
      };
    }
  }

  /**
   * Load extension from NPM package
   */
  private async loadFromNpm(packageName: string): Promise<ExtensionLoadResult> {
    try {
      // Parse package name and version
      const { name, _version } = this.parseNpmPackage(packageName);

      // Try to import the package
      // In a real implementation, this would use a package manager or CDN
      let module: Record<string, unknown>;

      try {
        // Try direct import (for installed packages)
        module = await import(name);
      } catch {
        // Try node_modules path
        try {
          const nodeModulesPath = path.join(
            process.cwd(),
            'node_modules',
            name
          );
          const packageJsonPath = path.join(nodeModulesPath, 'package.json');
          const packageJson = JSON.parse(
            await fs.readFile(packageJsonPath, 'utf-8')
          );
          const entryPoint = packageJson.main || 'index.js';
          const entryPath = path.join(nodeModulesPath, entryPoint);
          module = await import(pathToFileURL(entryPath).href);
        } catch {
          return {
            success: false,
            error: `Package not found: ${name}. Try running: npm install ${name}`,
          };
        }
      }

      const extension = module.default || module;

      if (!this.isExtensionLike(extension)) {
        return {
          success: false,
          error: 'Package does not export a valid extension',
        };
      }

      return { success: true, extension: extension as Extension };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to load from NPM: ${message}`,
      };
    }
  }

  /**
   * Evaluate extension code (for URL sources)
   */
  private async evaluateExtensionCode(
    code: string,
    _sourceUrl: string
  ): Promise<Extension> {
    // Create a data URL for dynamic import
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

    try {
      const module = await import(dataUrl);
      const extension = module.default || module;

      if (!this.isExtensionLike(extension)) {
        throw new Error('Code does not export a valid extension');
      }

      return extension as Extension;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to evaluate extension code: ${message}`);
    }
  }

  /**
   * Check if object looks like an extension
   */
  private isExtensionLike(obj: unknown): obj is Extension {
    if (!obj || typeof obj !== 'object') return false;

    const ext = obj as Record<string, unknown>;
    return (
      typeof ext['name'] === 'string' &&
      typeof ext['version'] === 'string' &&
      typeof ext['init'] === 'function' &&
      typeof ext['destroy'] === 'function'
    );
  }

  /**
   * Validate extension structure and metadata
   */
  private validateExtension(extension: Extension): ExtensionValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!extension.name || typeof extension.name !== 'string') {
      errors.push('Extension must have a valid name');
    }

    if (!extension.version || typeof extension.version !== 'string') {
      errors.push('Extension must have a valid version');
    }

    // Validate version format (semver-like)
    if (extension.version && !/^\d+\.\d+\.\d+/.test(extension.version)) {
      warnings.push('Version should follow semver format (x.y.z)');
    }

    // Validate lifecycle methods
    if (typeof extension.init !== 'function') {
      errors.push('Extension must have an init method');
    }

    if (typeof extension.destroy !== 'function') {
      errors.push('Extension must have a destroy method');
    }

    // Validate tools if present
    if (extension.tools) {
      if (!Array.isArray(extension.tools)) {
        errors.push('Extension tools must be an array');
      } else {
        extension.tools.forEach((tool, index) => {
          if (!tool.name) {
            errors.push(`Tool at index ${index} must have a name`);
          }
          if (!tool.execute || typeof tool.execute !== 'function') {
            errors.push(
              `Tool "${tool.name || index}" must have an execute function`
            );
          }
        });
      }
    }

    // Validate manifest if present
    if (extension.manifest) {
      const manifestValidation = this.validateManifest(extension.manifest);
      errors.push(...manifestValidation.errors);
      warnings.push(...manifestValidation.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate extension manifest
   */
  private validateManifest(
    manifest: ExtensionManifest
  ): ExtensionValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!manifest.name) {
      errors.push('Manifest must have a name');
    }

    if (!manifest.version) {
      errors.push('Manifest must have a version');
    }

    if (!manifest.permissions || !Array.isArray(manifest.permissions)) {
      errors.push('Manifest must have a permissions array');
    } else {
      // Validate each permission
      manifest.permissions.forEach((perm) => {
        if (!this.isValidPermission(perm)) {
          errors.push(`Invalid permission: ${perm}`);
        }
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Check if permission string is valid
   */
  private isValidPermission(permission: string): boolean {
    return ALLOWED_PERMISSION_PATTERNS.some((pattern) =>
      pattern.test(permission)
    );
  }

  /**
   * Verify extension permissions
   */
  private async verifyPermissions(
    extension: Extension,
    overridePermissions?: ExtensionPermission[]
  ): Promise<ExtensionLoadResult> {
    const requestedPermissions =
      overridePermissions || extension.manifest?.permissions || [];

    // Check for blocked network domains in permissions
    for (const perm of requestedPermissions) {
      if (perm.startsWith('network:')) {
        const domain = perm.slice(8);
        if (this.isBlockedDomain(domain)) {
          return {
            success: false,
            error: `Permission denied: network access to ${domain} is blocked`,
          };
        }
      }
    }

    // In a full implementation, this would prompt the user for approval
    // or check against a configured allowlist
    logger.debug('Permission verification passed', {
      extension: extension.name,
      permissions: requestedPermissions,
    });

    return { success: true, extension };
  }

  /**
   * Initialize extension with context
   */
  private async initializeExtension(
    extension: Extension,
    options: ExtensionLoadOptions
  ): Promise<ExtensionLoadResult> {
    try {
      const extensionId = this.generateExtensionId(extension);
      const permissions =
        options.permissions || extension.manifest?.permissions || [];

      // Create extension context
      const context = this.createExtensionContext(extensionId, permissions);

      // Store granted permissions
      this.grantedPermissions.set(extensionId, new Set(permissions));

      // Call init
      await extension.init(context);

      return { success: true, extension };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Extension initialization failed: ${message}`,
      };
    }
  }

  /**
   * Create extension context with permission-gated access
   */
  private createExtensionContext(
    extensionId: string,
    permissions: ExtensionPermission[]
  ): ExtensionContext {
    const permSet = new Set(permissions);

    const context: ExtensionContext = {
      extensionId,
      permissions,

      // State management (always available, scoped to extension)
      state: {
        get: async <T>(_key: string): Promise<T | undefined> => {
          // In a full implementation, this would use persistent storage
          return undefined;
        },
        set: async <T>(_key: string, _value: T): Promise<void> => {
          // In a full implementation, this would use persistent storage
        },
        delete: async (_key: string): Promise<void> => {
          // In a full implementation, this would use persistent storage
        },
      },

      // Sandboxed fetch (always available)
      fetch: this.createSandboxedFetch(extensionId, permSet),

      // Event system
      emit: (event: string, data: unknown): void => {
        if (!permSet.has('events:emit')) {
          logger.warn('Extension lacks events:emit permission', {
            extensionId,
            event,
          });
          return;
        }
        this.emitEvent(event, data);
      },

      on: (event: string, handler: EventHandler): (() => void) => {
        if (!permSet.has('events:listen')) {
          logger.warn('Extension lacks events:listen permission', {
            extensionId,
            event,
          });
          return () => {};
        }
        return this.addEventListener(event, handler);
      },

      off: (event: string, handler: EventHandler): void => {
        this.removeEventListener(event, handler);
      },
    };

    // Add frames access if permitted
    if (permSet.has('frames:read') || permSet.has('frames:write')) {
      context.frames = {
        get: async (_frameId: string) => {
          // In a full implementation, this would access the frame manager
          return undefined;
        },
        list: async () => {
          return [];
        },
      };

      if (permSet.has('frames:write')) {
        context.frames.create = async (_options) => {
          // In a full implementation, this would create a frame
          throw new Error('Frame creation not implemented');
        };
        context.frames.update = async (_frameId, _data) => {
          // In a full implementation, this would update a frame
          throw new Error('Frame update not implemented');
        };
      }
    }

    return context;
  }

  /**
   * Create sandboxed fetch that respects network permissions
   */
  private createSandboxedFetch(
    extensionId: string,
    permissions: Set<ExtensionPermission>
  ): typeof fetch {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname;

      // Check if extension has permission for this domain
      const hasPermission = Array.from(permissions).some((perm) => {
        if (!perm.startsWith('network:')) return false;
        const allowedDomain = perm.slice(8);

        // Support wildcard patterns
        if (allowedDomain.startsWith('*.')) {
          const baseDomain = allowedDomain.slice(2);
          return domain.endsWith(baseDomain);
        }

        return domain === allowedDomain;
      });

      if (!hasPermission) {
        throw new Error(`Network access denied for domain: ${domain}`);
      }

      // Check blocked domains
      if (this.isBlockedDomain(domain)) {
        throw new Error(`Network access blocked for domain: ${domain}`);
      }

      return fetch(input, init);
    };
  }

  /**
   * Check if domain is blocked
   */
  private isBlockedDomain(domain: string): boolean {
    return BLOCKED_DOMAINS.some((blocked) => {
      if (blocked.startsWith('*.')) {
        return domain.endsWith(blocked.slice(1));
      }
      if (blocked.endsWith('.*')) {
        return domain.startsWith(blocked.slice(0, -1));
      }
      return domain === blocked;
    });
  }

  /**
   * Register loaded extension
   */
  private registerExtension(
    extensionId: string,
    extension: Extension,
    source: string,
    sourceType: ExtensionSourceType,
    options: ExtensionLoadOptions
  ): void {
    const state: ExtensionState = {
      id: extensionId,
      name: extension.name,
      version: extension.version,
      source,
      sourceType,
      permissions: options.permissions || extension.manifest?.permissions || [],
      loadedAt: Date.now(),
      status: 'active',
    };

    this.loadedExtensions.set(extensionId, state);
    this.extensionInstances.set(extensionId, extension);
  }

  /**
   * Generate unique extension ID
   */
  private generateExtensionId(extension: Extension): string {
    return `${extension.name}@${extension.version}`;
  }

  /**
   * Parse NPM package string
   */
  private parseNpmPackage(packageName: string): {
    name: string;
    version?: string;
  } {
    const atIndex = packageName.lastIndexOf('@');
    if (atIndex > 0) {
      return {
        name: packageName.slice(0, atIndex),
        version: packageName.slice(atIndex + 1),
      };
    }
    return { name: packageName };
  }

  /**
   * Wrap promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    handlers.forEach((handler) => {
      try {
        const result = handler(data);
        if (result instanceof Promise) {
          result.catch((error) => {
            logger.error('Event handler error', { event, error });
          });
        }
      } catch (error) {
        logger.error('Event handler error', { event, error });
      }
    });
  }

  /**
   * Add event listener
   */
  private addEventListener(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => this.removeEventListener(event, handler);
  }

  /**
   * Remove event listener
   */
  private removeEventListener(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Disable an extension without unloading
   */
  async disableExtension(extensionId: string): Promise<boolean> {
    const state = this.loadedExtensions.get(extensionId);
    if (!state) return false;

    state.status = 'disabled';
    return true;
  }

  /**
   * Enable a disabled extension
   */
  async enableExtension(extensionId: string): Promise<boolean> {
    const state = this.loadedExtensions.get(extensionId);
    if (!state || state.status !== 'disabled') return false;

    state.status = 'active';
    return true;
  }

  /**
   * Unload all extensions
   */
  async unloadAll(): Promise<void> {
    const extensionIds = Array.from(this.loadedExtensions.keys());

    for (const extensionId of extensionIds) {
      await this.unloadExtension(extensionId);
    }
  }
}

/**
 * Singleton instance for convenience
 */
let loaderInstance: ExtensionLoader | undefined;

/**
 * Get the extension loader instance
 */
export function getExtensionLoader(): ExtensionLoader {
  if (!loaderInstance) {
    loaderInstance = new ExtensionLoader();
  }
  return loaderInstance;
}

/**
 * Load an extension (convenience function)
 */
export async function loadExtension(
  source: string,
  options?: Partial<ExtensionLoadOptions>
): Promise<ExtensionLoadResult> {
  const loader = getExtensionLoader();
  return loader.loadExtension({ source, ...options });
}

/**
 * Unload an extension (convenience function)
 */
export async function unloadExtension(extensionId: string): Promise<boolean> {
  const loader = getExtensionLoader();
  return loader.unloadExtension(extensionId);
}
