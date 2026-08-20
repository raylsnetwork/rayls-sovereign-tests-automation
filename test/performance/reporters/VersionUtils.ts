import { execSync } from 'child_process';
import { LOGGER } from '../../../src/config/env-config';

/**
 * Utility functions for getting version information for performance reports
 */
export class VersionUtils {
  /**
   * Get the current git branch name to use as version identifier
   * @returns The current git branch name or 'unknown' if unable to determine
   */
  static getCurrentVersion(): string {
    try {
      // Try to get the current git branch name
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr to avoid noise
      }).trim();
      
      return branch || 'unknown';
    } catch (error) {
      // If git command fails, try to get from environment variables
      // Some CI systems set these
      const ciEnvVars = [
        'GITHUB_REF_NAME',     // GitHub Actions
        'CI_COMMIT_REF_NAME',  // GitLab CI
        'BRANCH_NAME'          // Jenkins
      ];
      
      for (const envVar of ciEnvVars) {
        const envValue = process.env[envVar];
        if (envValue) {
          return envValue;
        }
      }
      
      // Fallback to 'unknown' if we can't determine the version
      LOGGER.error('Unable to determine git branch/version information');
      return 'unknown';
    }
  }

  /**
   * Get additional version metadata
   * @returns Object with version details
   */
  static getVersionInfo(): { version: string; commit?: string; timestamp: string } {
    const version = this.getCurrentVersion();
    let commit: string | undefined;
    
    try {
      // Try to get the current commit hash
      commit = execSync('git rev-parse --short HEAD', { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch (error) {
      // Commit hash is optional, continue without it
    }
    
    return {
      version,
      commit,
      timestamp: new Date().toISOString()
    };
  }
}
