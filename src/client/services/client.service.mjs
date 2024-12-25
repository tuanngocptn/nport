"use strict";

// Constants
const IDLE_SOCKET_TIMEOUT_MILLISECONDS = 1000 * 30;

// Import dependencies
import net from "net";
import ss from "socket.io-stream";
import { io as clientIo } from "socket.io-client";

// Export the main function as default
export default (options) => {
  return new Promise((resolve, reject) => {
    try {
      const socket = initializeSocketClient(options.server);
      setupSocketHandlers(socket, options, resolve, reject);
    } catch (err) {
      console.error(`${new Date()}: Error initializing client:`, err);
      reject(err);
    }
  });
};

const initializeSocketClient = (serverUrl) => {
  try {
    return clientIo(serverUrl);
  } catch (err) {
    console.error(`${new Date()}: Error initializing socket client:`, err);
    throw err;
  }
};

const setupSocketHandlers = (socket, options, resolve, reject) => {
  try {
    socket.on("connect", () => handleConnect(socket, options, resolve, reject));
    socket.on("incomingClient", (clientId) =>
      handleIncomingClient(socket, clientId, options)
    );
    socket.on("error", (err) => {
      console.error(`${new Date()}: Socket error:`, err);
      reject(err);
    });
  } catch (err) {
    console.error(`${new Date()}: Error setting up socket handlers:`, err);
    reject(err);
  }
};

const handleConnect = (socket, options, resolve, reject) => {
  try {
    logConnectionStatus(options);
    requestTunnel(socket, options, resolve, reject);
  } catch (err) {
    console.error(`${new Date()}: Error handling connect:`, err);
    reject(err);
  }
};

const logConnectionStatus = (options) => {
  try {
    console.log(`${new Date()}: connected`);
    console.log(
      `${new Date()}: requesting subdomain ${options.subdomain} via ${
        options.server
      }`
    );
  } catch (err) {
    console.error(`${new Date()}: Error logging connection status:`, err);
    throw err;
  }
};

const requestTunnel = (socket, options, resolve, reject) => {
  try {
    socket.emit("createTunnel", options.subdomain, (err) => {
      if (err) {
        handleTunnelError(err, reject);
      } else {
        handleTunnelSuccess(options, resolve);
      }
    });
  } catch (err) {
    console.error(`${new Date()}: Error requesting tunnel:`, err);
    reject(err);
  }
};

const handleTunnelError = (err, reject) => {
  console.error(`${new Date()}: Tunnel error:`, err);
  reject(err);
};

const handleTunnelSuccess = (options, resolve) => {
  try {
    console.log(`${new Date()}: registered with server successfully`);
    console.log(
      `${new Date()}: your domain is: https://${options.subdomain}.nport.link`
    );
    resolve(constructUrl(options));
  } catch (err) {
    console.error(`${new Date()}: Error handling tunnel success:`, err);
    throw err;
  }
};

const constructUrl = (options) => {
  try {
    const subdomain = options.subdomain.toString();
    const server = options.server.toString();

    if (server.includes("https://")) {
      return `https://${subdomain}.${server.slice(8)}`;
    } else if (server.includes("http://")) {
      return `http://${subdomain}.${server.slice(7)}`;
    }
    return `https://${subdomain}.${server}`;
  } catch (err) {
    console.error(`${new Date()}: Error constructing URL:`, err);
    throw err;
  }
};

const handleIncomingClient = (socket, clientId, options) => {
  try {
    const client = createTcpConnection(options);
    setupClientHandlers(client, socket, clientId);
  } catch (err) {
    console.error(`${new Date()}: Error handling incoming client:`, err);
  }
};

const createTcpConnection = (options) => {
  try {
    const client = net.connect({
      port: options.port,
      host: options.hostname,
      timeout: IDLE_SOCKET_TIMEOUT_MILLISECONDS
    });
    return client;
  } catch (err) {
    console.error(`${new Date()}: Error creating TCP connection:`, err);
    throw err;
  }
};

const setupClientHandlers = (client, socket, clientId) => {
  try {
    client.once('connect', () => {
      handleClientConnect(client, socket, clientId);
    });

    client.once('error', (err) => {
      console.error(`${new Date()}: Client error:`, err);
      handleClientError(socket, clientId);
    });

    client.once('timeout', () => {
      console.log(`${new Date()}: Client connection timed out`);
      client.end();
    });
  } catch (err) {
    console.error(`${new Date()}: Error setting up client handlers:`, err);
  }
};

const handleClientConnect = (client, socket, clientId) => {
  try {
    const stream = ss.createStream();
    
    stream.once('error', (err) => {
      console.error(`${new Date()}: Stream error:`, err);
      cleanupConnection(client, stream);
    });

    client.once('error', (err) => {
      console.error(`${new Date()}: Client error in stream:`, err);
      cleanupConnection(client, stream);
    });

    stream.once('end', () => {
      cleanupConnection(client, stream);
    });

    client.once('end', () => {
      cleanupConnection(client, stream);
    });

    // Emit the stream through socket.io-stream
    ss(socket).emit(clientId, stream);

    // Setup piping
    client.pipe(stream).pipe(client);

  } catch (err) {
    console.error(`${new Date()}: Error in handleClientConnect:`, err);
    if (client && !client.destroyed) {
      client.destroy();
    }
  }
};

const cleanupConnection = (client, stream) => {
  try {
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
    if (client && !client.destroyed) {
      client.destroy();
    }
  } catch (err) {
    console.error(`${new Date()}: Error in cleanup:`, err);
  }
};

const handleClientError = (socket, clientId) => {
  try {
    const stream = ss.createStream();
    ss(socket).emit(clientId, stream);
    stream.end();
  } catch (err) {
    console.error(`${new Date()}: Error handling client error:`, err);
  }
};
