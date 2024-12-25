// Import dependencies
import http from "http";
import tldjs from "tldjs";
import ss from "socket.io-stream";
import { v4 as uuid } from "uuid";
import isValidDomain from "is-valid-domain";
import { Server as SocketIO } from "socket.io";
const socketsBySubdomain = {};
let options = {};

// Export the main function as default
export default ({ port, hostname, subdomain }) => {
  options = { port, hostname, subdomain };
  // Association between subdomains and socket.io sockets

  // Create HTTP server to handle tunnel requests
  const server = createTunnelServer();

  // Initialize socket.io
  initializeSocketIO(server);

  // Start the HTTP server
  server.listen(options.port, options.hostname);
  console.log(
    `${new Date()}: socket-tunnel server started on ${options.hostname}:${
      options.port
    }`
  );
};

const createTunnelServer = () => {
  return http.createServer(async (req, res) => {
    try {
      await handleTunnelRequest(req, res);
    } catch (err) {
      console.error(`${new Date()}: Error in tunnel server:`, err);
      handleTunnelError(res, err);
    }
  });
};

const handleTunnelRequest = async (req, res) => {
  try {
    const tunnelClientStream = await getTunnelClientStreamForReq(req);
    const reqBodyChunks = [];

    setupRequestErrorHandler(req);
    setupRequestDataHandler(req, reqBodyChunks);
    setupRequestEndHandler(req, reqBodyChunks, tunnelClientStream);
  } catch (err) {
    console.error(`${new Date()}: Error handling tunnel request:`, err);
    throw err;
  }
};

const setupRequestErrorHandler = (req) => {
  req.on("error", (err) => {
    console.error(`${new Date()}: Request error:`, err.stack);
  });
};

const setupRequestDataHandler = (req, reqBodyChunks) => {
  req.on("data", (bodyChunk) => {
    try {
      reqBodyChunks.push(bodyChunk);
    } catch (err) {
      console.error(`${new Date()}: Error handling request data:`, err);
    }
  });
};

const setupRequestEndHandler = (req, reqBodyChunks, tunnelClientStream) => {
  req.on("end", () => {
    try {
      if (!req.complete) {
        console.warn(`${new Date()}: Incomplete request received`);
        return;
      }

      const reqLine = getReqLineFromReq(req);
      const headers = getHeadersFromReq(req);
      const reqBody =
        reqBodyChunks.length > 0 ? Buffer.concat(reqBodyChunks) : null;

      streamResponse(reqLine, headers, reqBody, tunnelClientStream);
    } catch (err) {
      console.error(`${new Date()}: Error in request end handler:`, err);
    }
  });
};

const handleTunnelError = (res, err) => {
  console.error(`${new Date()}: Tunnel error:`, err);
  res.statusCode = 502;
  res.end(err.message);
};

const getTunnelClientStreamForReq = async (req) => {
  return new Promise((resolve, reject) => {
    try {
      const hostname = validateHostname(req.headers.host, reject);
      let subdomain = getSubdomain(hostname, options.subdomain);

      const subdomainSocket = validateSocket(
        subdomain,
        socketsBySubdomain,
        reject
      );

      if (isExistingValidStream(req, subdomain)) {
        return resolve(req.connection.tunnelClientStream);
      }

      establishNewStream(req, subdomainSocket, subdomain, resolve);
    } catch (err) {
      console.error(`${new Date()}: Error getting tunnel client stream:`, err);
      reject(err);
    }
  });
};

const validateHostname = (hostname, reject) => {
  if (!hostname) {
    console.error(`${new Date()}: Invalid hostname received`);
    reject(new Error("Invalid hostname"));
  }
  return hostname;
};

const getSubdomain = (hostname, optionsSubdomain) => {
  try {
    let subdomain = tldjs.getSubdomain(hostname).toLowerCase();
    if (!subdomain) {
      const error = new Error(
        "Invalid subdomain"
      );
      console.error(`${new Date()}: Invalid subdomain:`, error);
      throw error;
    }
    if (optionsSubdomain) {
      subdomain = subdomain.replace(`.${optionsSubdomain}`, "");
    }
    return subdomain;
  } catch (err) {
    console.error(`${new Date()}: Error processing subdomain:`, err);
    throw err;
  }
};

const validateSocket = (subdomain, sockets, reject) => {
  const socket = sockets[subdomain];
  if (!socket) {
    const error = new Error(
      `${subdomain} is currently unregistered or offline.`
    );
    console.error(`${new Date()}: Socket validation failed:`, error);
    reject(error);
  }
  return socket;
};

const isExistingValidStream = (req, subdomain) => {
  return (
    req.connection.tunnelClientStream !== undefined &&
    !req.connection.tunnelClientStream.destroyed &&
    req.connection.subdomain === subdomain
  );
};

const establishNewStream = (req, socket, subdomain, resolve) => {
  try {
    const requestGUID = uuid();
    ss(socket).once(requestGUID, (tunnelClientStream) => {
      try {
        req.connection.subdomain = subdomain;
        req.connection.tunnelClientStream = tunnelClientStream;
        tunnelClientStream.pipe(req.connection);
        resolve(tunnelClientStream);
      } catch (err) {
        console.error(`${new Date()}: Error establishing stream:`, err);
      }
    });
    socket.emit("incomingClient", requestGUID);
  } catch (err) {
    console.error(`${new Date()}: Error setting up stream:`, err);
  }
};

const getReqLineFromReq = (req) => {
  try {
    return `${req.method} ${req.url} HTTP/${req.httpVersion}`;
  } catch (err) {
    console.error(`${new Date()}: Error getting request line:`, err);
    throw err;
  }
};

const getHeadersFromReq = (req) => {
  try {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
      headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    return headers;
  } catch (err) {
    console.error(`${new Date()}: Error processing headers:`, err);
    throw err;
  }
};

const streamResponse = (reqLine, headers, reqBody, tunnelClientStream) => {
  try {
    tunnelClientStream.write(reqLine);
    tunnelClientStream.write("\r\n");
    tunnelClientStream.write(headers.join("\r\n"));
    tunnelClientStream.write("\r\n\r\n");
    if (reqBody) {
      tunnelClientStream.write(reqBody);
    }
  } catch (err) {
    console.error(`${new Date()}: Error streaming response:`, err);
  }
};

const initializeSocketIO = (server) => {
  try {
    const io = new SocketIO(server);
    io.on("connection", handleSocketConnection);
  } catch (err) {
    console.error(`${new Date()}: Error initializing Socket.IO:`, err);
  }
};

const handleSocketConnection = (socket) => {
  socket.on("createTunnel", (requestedName, responseCb) => {
    try {
      handleTunnelCreation(socket, requestedName, responseCb);
    } catch (err) {
      console.error(`${new Date()}: Error in tunnel creation:`, err);
    }
  });

  socket.on("disconnect", () => {
    try {
      handleSocketDisconnect(socket);
    } catch (err) {
      console.error(`${new Date()}: Error handling disconnect:`, err);
    }
  });
};

const handleTunnelCreation = (socket, requestedName, responseCb) => {
  try {
    if (socket.requestedName) return;

    const reqNameNormalized = normalizeRequestedName(requestedName);

    if (!isValidTunnelName(reqNameNormalized)) {
      handleInvalidTunnelName(reqNameNormalized, socket, responseCb);
      return;
    }

    if (isTunnelNameTaken(reqNameNormalized)) {
      handleTakenTunnelName(reqNameNormalized, socket, responseCb);
      return;
    }

    registerTunnel(socket, reqNameNormalized, responseCb);
  } catch (err) {
    console.error(`${new Date()}: Error handling tunnel creation:`, err);
  }
};

const normalizeRequestedName = (name) => {
  try {
    return name
      .toString()
      .toLowerCase()
      .replace(/[^0-9a-z-.]/g, "");
  } catch (err) {
    console.error(`${new Date()}: Error normalizing name:`, err);
    throw err;
  }
};

const isValidTunnelName = (name) => {
  try {
    return name.length > 0 && isValidDomain(`${name}.example.com`);
  } catch (err) {
    console.error(`${new Date()}: Error validating tunnel name:`, err);
    return false;
  }
};

const isTunnelNameTaken = (name) => {
  try {
    return !!socketsBySubdomain[name];
  } catch (err) {
    console.error(
      `${new Date()}: Error checking tunnel name availability:`,
      err
    );
    return true;
  }
};

const handleInvalidTunnelName = (name, socket, responseCb) => {
  try {
    console.log(
      `${new Date()}: ${name} -- bad subdomain. Disconnecting client.`
    );
    if (responseCb) responseCb("bad subdomain");
    socket.disconnect();
  } catch (err) {
    console.error(`${new Date()}: Error handling invalid tunnel name:`, err);
  }
};

const handleTakenTunnelName = (name, socket, responseCb) => {
  try {
    console.log(
      `${new Date()}: ${name} requested but already claimed. Disconnecting client.`
    );
    if (responseCb) responseCb("subdomain already claimed");
    socket.disconnect();
  } catch (err) {
    console.error(`${new Date()}: Error handling taken tunnel name:`, err);
  }
};

const registerTunnel = (socket, name, responseCb) => {
  try {
    socketsBySubdomain[name] = socket;
    socket.requestedName = name;
    console.log(`${new Date()}: ${name} registered successfully`);
    if (responseCb) responseCb(null);
  } catch (err) {
    console.error(`${new Date()}: Error registering tunnel:`, err);
  }
};

const handleSocketDisconnect = (socket) => {
  try {
    if (socket.requestedName) {
      delete socketsBySubdomain[socket.requestedName];
      console.log(`${new Date()}: ${socket.requestedName} unregistered`);
    }
  } catch (err) {
    console.error(`${new Date()}: Error handling socket disconnect:`, err);
  }
};
