"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _net = _interopRequireDefault(require("net"));
var _socket = _interopRequireDefault(require("socket.io-stream"));
var _socket2 = require("socket.io-client");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// Constants
const IDLE_SOCKET_TIMEOUT_MILLISECONDS = 1000 * 30;

// Import dependencies
/**
 * Creates and initializes a socket tunnel client
 * @param {Object} options Configuration options
 * @returns {Promise<string>} The constructed tunnel URL
 */
var _default = options => {
  return new Promise((resolve, reject) => {
    try {
      const socket = (0, _socket2.io)(options.server);
      initializeSocketConnection(socket, options, resolve, reject);
    } catch (err) {
      logError("Error initializing client", err);
      reject(err);
    }
  });
};
/**
 * Sets up the main socket connection and event handlers
 */
exports.default = _default;
const initializeSocketConnection = (socket, options, resolve, reject) => {
  try {
    socket.on("connect", () => onSocketConnect(socket, options, resolve, reject));
    socket.on("incomingClient", clientId => handleIncomingClient(socket, options, clientId));
    socket.on("error", err => {
      logError("Socket error", err);
      reject(err);
    });
  } catch (err) {
    logError("Error setting up socket handlers", err);
    reject(err);
  }
};

/**
 * Handles successful socket connection
 */
const onSocketConnect = (socket, options, resolve, reject) => {
  try {
    logInfo(`Requesting subdomain ${options.subdomain} via ${options.server}`);
    establishTunnel(socket, options, resolve, reject);
  } catch (err) {
    logError("Error handling connect", err);
    reject(err);
  }
};

/**
 * Requests tunnel creation from server
 */
const establishTunnel = (socket, options, resolve, reject) => {
  try {
    socket.emit("createTunnel", options.subdomain, err => {
      if (err) {
        logError("Tunnel error", err);
        reject(err);
      } else {
        logInfo("Registered with server successfully");
        logInfo(`Your domain is: https://${options.subdomain}.nport.link`);
        resolve(buildTunnelUrl(options));
      }
    });
  } catch (err) {
    logError("Error requesting tunnel", err);
    reject(err);
  }
};

/**
 * Constructs the tunnel URL based on server protocol
 */
const buildTunnelUrl = options => {
  const subdomain = options.subdomain.toString();
  const server = options.server.toString();
  if (server.includes("https://")) {
    return `https://${subdomain}.${server.slice(8)}`;
  } else if (server.includes("http://")) {
    return `http://${subdomain}.${server.slice(7)}`;
  }
  return `https://${subdomain}.${server}`;
};

/**
 * Creates a TCP connection to the target service
 */
const createTcpConnection = options => {
  return _net.default.connect({
    port: options.port,
    host: options.hostname,
    timeout: IDLE_SOCKET_TIMEOUT_MILLISECONDS
  });
};

/**
 * Handles incoming client connections
 */
const handleIncomingClient = (socket, options, clientId) => {
  const client = createTcpConnection(options);
  setupClientEventHandlers(client, socket, clientId);
};

/**
 * Sets up TCP client event handlers
 */
const setupClientEventHandlers = (client, socket, clientId) => {
  client.once("connect", () => {
    setupStreamConnection(client, socket, clientId);
  });
  client.once("error", err => {
    logError("Client error", err);
    handleClientFailure(socket, clientId);
  });
  client.once("timeout", () => {
    logInfo("Client connection timed out");
    client.end();
  });
};

/**
 * Sets up bidirectional stream between client and tunnel
 */
const setupStreamConnection = (client, socket, clientId) => {
  try {
    const stream = _socket.default.createStream();
    setupStreamEventHandlers(stream, client);

    // Connect stream to socket.io tunnel
    (0, _socket.default)(socket).emit(clientId, stream);

    // Enable bidirectional data flow
    client.pipe(stream).pipe(client);
  } catch (err) {
    logError("Error in stream setup", err);
    safelyDestroyClient(client);
  }
};

/**
 * Sets up stream event handlers
 */
const setupStreamEventHandlers = (stream, client) => {
  stream.once("error", err => {
    logError("Stream error", err);
    cleanup(client, stream);
  });
  client.once("error", err => {
    logError("Client error in stream", err);
    cleanup(client, stream);
  });
  stream.once("end", () => cleanup(client, stream));
  client.once("end", () => cleanup(client, stream));
};

/**
 * Safely cleans up resources
 */
const cleanup = (client, stream) => {
  safelyDestroyStream(stream);
  safelyDestroyClient(client);
};
const safelyDestroyStream = stream => {
  if (stream && !stream.destroyed) {
    stream.destroy();
  }
};
const safelyDestroyClient = client => {
  if (client && !client.destroyed) {
    client.destroy();
  }
};

/**
 * Handles client connection failures
 */
const handleClientFailure = (socket, clientId) => {
  const stream = _socket.default.createStream();
  (0, _socket.default)(socket).emit(clientId, stream);
  stream.end();
};

// Logging helpers
const logError = (message, error) => {
  console.error(`${new Date()}: ${message}:`, error);
};
const logInfo = message => {
  console.log(`${new Date()}: ${message}`);
};