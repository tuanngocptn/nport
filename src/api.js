import axios from "axios";
import chalk from "chalk";
import { CONFIG } from "./config.js";
import { state } from "./state.js";

/**
 * @typedef {Object} TunnelResponse
 * @property {string} tunnelId - UUID of the created tunnel
 * @property {string} tunnelToken - Base64-encoded token for cloudflared authentication
 * @property {string} url - Full HTTPS URL of the tunnel (e.g., "https://myapp.nport.link")
 */

/**
 * API Client
 * 
 * Handles all communication with the NPort backend service.
 * The backend is a Cloudflare Worker that manages tunnel creation/deletion
 * via Cloudflare's Tunnel and DNS APIs.
 * 
 * @example
 * // Create a tunnel
 * const tunnel = await APIClient.createTunnel("myapp");
 * console.log(tunnel.url); // https://myapp.nport.link
 * 
 * @example
 * // Delete a tunnel
 * await APIClient.deleteTunnel("myapp", tunnel.tunnelId);
 */
export class APIClient {
  /**
   * Creates a new Cloudflare tunnel via the backend API.
   * 
   * This method:
   * 1. Sends a POST request to the backend with the subdomain
   * 2. Backend creates a Cloudflare Tunnel and DNS CNAME record
   * 3. Returns the tunnel credentials needed for cloudflared
   * 
   * @param {string} subdomain - The subdomain to use (e.g., "myapp" for myapp.nport.link)
   * @param {string|null} [backendUrl=null] - Custom backend URL, or null to use default
   * @returns {Promise<TunnelResponse>} Tunnel credentials and URL
   * @throws {Error} If subdomain is taken, protected, or API fails
   * 
   * @example
   * const tunnel = await APIClient.createTunnel("myapp");
   * // tunnel = {
   * //   tunnelId: "abc123...",
   * //   tunnelToken: "eyJ...",
   * //   url: "https://myapp.nport.link"
   * // }
   */
  static async createTunnel(subdomain, backendUrl = null) {
    const url = backendUrl || CONFIG.BACKEND_URL;
    try {
      const { data } = await axios.post(url, { subdomain });

      if (!data.success) {
        throw new Error(data.error || "Unknown error from backend");
      }

      return {
        tunnelId: data.tunnelId,
        tunnelToken: data.tunnelToken,
        url: data.url,
      };
    } catch (error) {
      throw this.handleError(error, subdomain);
    }
  }

  /**
   * Deletes an existing tunnel and its associated DNS record.
   * 
   * This method:
   * 1. Sends a DELETE request to the backend
   * 2. Backend removes the DNS CNAME record
   * 3. Backend deletes the Cloudflare Tunnel
   * 
   * @param {string} subdomain - The subdomain to remove (e.g., "myapp")
   * @param {string} tunnelId - The tunnel UUID to delete
   * @param {string|null} [backendUrl=null] - Custom backend URL, or null to use default
   * @returns {Promise<void>}
   * @throws {Error} If the API request fails
   * 
   * @example
   * await APIClient.deleteTunnel("myapp", "abc123-def456-...");
   */
  static async deleteTunnel(subdomain, tunnelId, backendUrl = null) {
    const url = backendUrl || CONFIG.BACKEND_URL;
    await axios.delete(url, {
      data: { subdomain, tunnelId },
    });
  }

  /**
   * Transforms API errors into user-friendly error messages.
   * 
   * Handles specific error types:
   * - SUBDOMAIN_PROTECTED: Reserved subdomains (e.g., "api")
   * - SUBDOMAIN_IN_USE: Active tunnel exists with this subdomain
   * - Cloudflare [1013] errors: Duplicate tunnel name
   * 
   * @param {Error} error - The original error from axios
   * @param {string} subdomain - The subdomain that was attempted
   * @returns {Error} A new error with formatted, user-friendly message
   * @private
   * 
   * @example
   * // Internal use - transforms API error to readable format
   * catch (error) {
   *   throw this.handleError(error, "myapp");
   * }
   */
  static handleError(error, subdomain) {
    if (error.response?.data?.error) {
      const errorMsg = error.response.data.error;

      // Check for protected subdomain (reserved for production services)
      if (errorMsg.includes("SUBDOMAIN_PROTECTED:")) {
        return new Error(
          `Subdomain "${subdomain}" is already taken or in use.\n\n` +
            chalk.yellow(`💡 Try one of these options:\n`) +
            chalk.gray(`   1. Choose a different subdomain: `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-v2\n`) +
            chalk.gray(`   2. Use a random subdomain:       `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`) +
            chalk.gray(
              `   3. Wait a few minutes and retry if you just stopped a tunnel with this name`
            )
        );
      }

      // Check for subdomain in use (active tunnel)
      if (
        errorMsg.includes("SUBDOMAIN_IN_USE:") ||
        errorMsg.includes("currently in use") ||
        errorMsg.includes("already exists and is currently active")
      ) {
        return new Error(
          chalk.red(`✗ Subdomain "${subdomain}" is already in use!\n\n`) +
            chalk.yellow(`💡 This subdomain is currently being used by another active tunnel.\n\n`) +
            chalk.white(`Choose a different subdomain:\n`) +
            chalk.gray(`   1. Add a suffix:     `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-2\n`) +
            chalk.gray(`   2. Try a variation:  `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s my-${subdomain}\n`) +
            chalk.gray(`   3. Use random name:  `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`)
        );
      }

      // Check for duplicate tunnel error (other Cloudflare errors)
      if (
        errorMsg.includes("already have a tunnel") ||
        errorMsg.includes("[1013]")
      ) {
        return new Error(
          `Subdomain "${subdomain}" is already taken or in use.\n\n` +
            chalk.yellow(`💡 Try one of these options:\n`) +
            chalk.gray(`   1. Choose a different subdomain: `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT} -s ${subdomain}-v2\n`) +
            chalk.gray(`   2. Use a random subdomain:       `) +
            chalk.cyan(`nport ${state.port || CONFIG.DEFAULT_PORT}\n`) +
            chalk.gray(
              `   3. Wait a few minutes and retry if you just stopped a tunnel with this name`
            )
        );
      }

      return new Error(`Backend Error: ${errorMsg}`);
    }

    if (error.response) {
      const errorMsg = JSON.stringify(error.response.data, null, 2);
      return new Error(`Backend Error: ${errorMsg}`);
    }

    return error;
  }
}
