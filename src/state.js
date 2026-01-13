/**
 * Application State Manager
 * Manages tunnel state including connection info, process, and timers
 */
class TunnelState {
  constructor() {
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.backendUrl = null;
    this.tunnelProcess = null;
    this.timeoutId = null;
    this.connectionCount = 0;
    this.startTime = null;
    this.updateInfo = null;
  }

  setTunnel(tunnelId, subdomain, port, backendUrl = null) {
    this.tunnelId = tunnelId;
    this.subdomain = subdomain;
    this.port = port;
    this.backendUrl = backendUrl;
    if (!this.startTime) {
      this.startTime = Date.now();
    }
  }

  setUpdateInfo(updateInfo) {
    this.updateInfo = updateInfo;
  }

  setProcess(process) {
    this.tunnelProcess = process;
  }

  setTimeout(timeoutId) {
    this.timeoutId = timeoutId;
  }

  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  incrementConnection() {
    this.connectionCount++;
    return this.connectionCount;
  }

  hasTunnel() {
    return this.tunnelId !== null;
  }

  hasProcess() {
    return this.tunnelProcess && !this.tunnelProcess.killed;
  }

  getDurationSeconds() {
    if (!this.startTime) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  reset() {
    this.clearTimeout();
    this.tunnelId = null;
    this.subdomain = null;
    this.port = null;
    this.backendUrl = null;
    this.tunnelProcess = null;
    this.connectionCount = 0;
    this.startTime = null;
    this.updateInfo = null;
  }
}

export const state = new TunnelState();

