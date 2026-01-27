import axios from 'axios';
import chalk from 'chalk';
import type { TunnelResponse, CreateTunnelApiResponse } from './types/index.js';
import { CONFIG } from './config.js';
import { state } from './state.js';

/**
 * API Client
 * 
 * Handles all communication with the NPort backend service.
 */
export class APIClient {
  /**
   * Creates a new Cloudflare tunnel via the backend API.
   */
  static async createTunnel(subdomain: string, backendUrl: string | null = null): Promise<TunnelResponse> {
    const url = backendUrl || CONFIG.BACKEND_URL;
    try {
      const { data } = await axios.post<CreateTunnelApiResponse>(url, { subdomain });

      if (!data.success) {
        throw new Error(data.error || 'Unknown error from backend');
      }

      return {
        tunnelId: data.tunnelId!,
        tunnelToken: data.tunnelToken!,
        url: data.url!,
      };
    } catch (error) {
      throw this.handleError(error as Error & { response?: { data?: { error?: string } } }, subdomain);
    }
  }

  /**
   * Deletes an existing tunnel.
   */
  static async deleteTunnel(subdomain: string, tunnelId: string, backendUrl: string | null = null): Promise<void> {
    const url = backendUrl || CONFIG.BACKEND_URL;
    await axios.delete(url, {
      data: { subdomain, tunnelId },
    });
  }

  /**
   * Transforms API errors into user-friendly messages.
   */
  private static handleError(error: Error & { response?: { data?: { error?: string } } }, subdomain: string): Error {
    const errorMsg = error.response?.data?.error;
    
    if (errorMsg) {
      if (errorMsg.includes('SUBDOMAIN_PROTECTED:')) {
        return new Error(
          `Subdomain "${subdomain}" is already taken or in use.\n\n` +
            chalk.yellow('💡 Try one of these options:\n') +
            chalk.gray('   1. Choose a different subdomain: ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-v2\n`) +
            chalk.gray('   2. Use a random subdomain:       ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`) +
            chalk.gray('   3. Wait a few minutes and retry if you just stopped a tunnel with this name')
        );
      }

      if (
        errorMsg.includes('SUBDOMAIN_IN_USE:') ||
        errorMsg.includes('currently in use') ||
        errorMsg.includes('already exists and is currently active')
      ) {
        return new Error(
          chalk.red(`✗ Subdomain "${subdomain}" is already in use!\n\n`) +
            chalk.yellow('💡 This subdomain is currently being used by another active tunnel.\n\n') +
            chalk.white('Choose a different subdomain:\n') +
            chalk.gray('   1. Add a suffix:     ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-2\n`) +
            chalk.gray('   2. Try a variation:  ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s my-${subdomain}\n`) +
            chalk.gray('   3. Use random name:  ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`)
        );
      }

      if (errorMsg.includes('already have a tunnel') || errorMsg.includes('[1013]')) {
        return new Error(
          `Subdomain "${subdomain}" is already taken or in use.\n\n` +
            chalk.yellow('💡 Try one of these options:\n') +
            chalk.gray('   1. Choose a different subdomain: ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-v2\n`) +
            chalk.gray('   2. Use a random subdomain:       ') +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`) +
            chalk.gray('   3. Wait a few minutes and retry if you just stopped a tunnel with this name')
        );
      }

      return new Error(`Backend Error: ${errorMsg}`);
    }

    if (error.response) {
      return new Error(`Backend Error: ${JSON.stringify(error.response.data, null, 2)}`);
    }

    return error;
  }
}
