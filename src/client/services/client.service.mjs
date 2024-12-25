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
      const socket = clientIo(options.server);
      setupSocketHandlers(socket, options, resolve, reject);
    } catch (err) {
      console.error(`${new Date()}: Error initializing client:`, err);
      reject(err);
    }
  });
};

const setupSocketHandlers = (socket, options, resolve, reject) => {
  try {
    socket.on("connect", () => handleConnect(socket, options, resolve, reject));
    socket.on("incomingClient", (clientId) => {
      const client = createTcpConnection(options);
      setupClientHandlers(client, socket, clientId);
    });
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
    console.log(
      `${new Date()}: requesting subdomain ${options.subdomain} via ${
        options.server
      }`
    );
    requestTunnel(socket, options, resolve, reject);
  } catch (err) {
    console.error(`${new Date()}: Error handling connect:`, err);
    reject(err);
  }
};

const requestTunnel = (socket, options, resolve, reject) => {
  try {
    socket.emit("createTunnel", options.subdomain, (err) => {
      if (err) {
        console.error(`${new Date()}: Tunnel error:`, err);
        reject(err);
      } else {
        console.log(`${new Date()}: registered with server successfully`);
        console.log(
          `${new Date()}: your domain is: https://${
            options.subdomain
          }.nport.link`
        );
        resolve(constructUrl(options));
      }
    });
  } catch (err) {
    console.error(`${new Date()}: Error requesting tunnel:`, err);
    reject(err);
  }
};

const constructUrl = (options) => {
  const subdomain = options.subdomain.toString();
  const server = options.server.toString();

  if (server.includes("https://")) {
    return `https://${subdomain}.${server.slice(8)}`;
  } else if (server.includes("http://")) {
    return `http://${subdomain}.${server.slice(7)}`;
  }
  return `https://${subdomain}.${server}`;
};

const createTcpConnection = (options) => {
  const client = net.connect({
    port: options.port,
    host: options.hostname,
    timeout: IDLE_SOCKET_TIMEOUT_MILLISECONDS,
  });
  return client;
};

const setupClientHandlers = (client, socket, clientId) => {
  client.once("connect", () => {
    handleClientConnect(client, socket, clientId);
  });

  client.once("error", (err) => {
    console.error(`${new Date()}: Client error:`, err);
    handleClientError(socket, clientId);
  });

  client.once("timeout", () => {
    console.log(`${new Date()}: Client connection timed out`);
    client.end();
  });
};

const handleClientConnect = (client, socket, clientId) => {
  try {
    const stream = ss.createStream();

    stream.once("error", (err) => {
      console.error(`${new Date()}: Stream error:`, err);
      cleanupConnection(client, stream);
    });

    client.once("error", (err) => {
      console.error(`${new Date()}: Client error in stream:`, err);
      cleanupConnection(client, stream);
    });

    stream.once("end", () => {
      cleanupConnection(client, stream);
    });

    client.once("end", () => {
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
  if (stream && !stream.destroyed) {
    stream.destroy();
  }
  if (client && !client.destroyed) {
    client.destroy();
  }
};

const handleClientError = (socket, clientId) => {
  const stream = ss.createStream();
  ss(socket).emit(clientId, stream);
  stream.end();
};
