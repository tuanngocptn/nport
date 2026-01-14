import axios from "axios";
import chalk from "chalk";
import { CONFIG } from "./config.js";
import { state } from "./state.js";

/**
 * API Client
 * Handles communication with the NPort backend service
 */
export class APIClient {
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

  static async deleteTunnel(subdomain, tunnelId, backendUrl = null) {
    const url = backendUrl || CONFIG.BACKEND_URL;
    await axios.delete(url, {
      data: { subdomain, tunnelId },
    });
  }

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

