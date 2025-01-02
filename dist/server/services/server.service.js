"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _http = _interopRequireDefault(require("http"));
var _tldjs = _interopRequireDefault(require("tldjs"));
var _socket = _interopRequireDefault(require("socket.io-stream"));
var _uuid = require("uuid");
var _validator = _interopRequireDefault(require("validator"));
var _socket2 = require("socket.io");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// Import dependencies

// Global state
const socketsBySubdomain = {};
let serverOptions = {};

// Main server initialization
var _default = ({
  port,
  hostname,
  subdomain
}) => {
  serverOptions = {
    port,
    hostname,
    subdomain
  };
  const server = createHttpServer();
  initializeSocketServer(server);
  startServer(server);
}; // HTTP Server Setup
exports.default = _default;
const createHttpServer = () => {
  return _http.default.createServer(async (req, res) => {
    try {
      await handleHttpRequest(req, res);
    } catch (err) {
      handleServerError(res, err);
    }
  });
};
const startServer = server => {
  server.listen(serverOptions.port, serverOptions.hostname);
  console.log(`${new Date()}: socket-tunnel server started on ${serverOptions.hostname}:${serverOptions.port}`);
};

// HTTP Request Handling
const handleHttpRequest = async (req, res) => {
  const tunnelStream = await setupTunnelStream(req);
  const requestBody = await collectRequestBody(req);
  forwardRequestToTunnel(req, requestBody, tunnelStream);
};
const collectRequestBody = async req => {
  const bodyChunks = [];
  req.on("error", err => {
    console.error(`${new Date()}: Request error:`, err.stack);
  });
  req.on("data", chunk => bodyChunks.push(chunk));
  return new Promise(resolve => {
    req.on("end", () => {
      if (!req.complete) {
        console.warn(`${new Date()}: Incomplete request received`);
        resolve(null);
        return;
      }
      resolve(bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null);
    });
  });
};
const forwardRequestToTunnel = (req, body, tunnelStream) => {
  // Format request line and headers
  const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
  const headers = formatHeaders(req.rawHeaders);

  // Write request to tunnel
  tunnelStream.write(requestLine + "\r\n");
  tunnelStream.write(headers.join("\r\n") + "\r\n\r\n");
  if (body) {
    tunnelStream.write(body);
  }
};
const formatHeaders = rawHeaders => {
  const headers = [];
  for (let i = 0; i < rawHeaders.length - 1; i += 2) {
    headers.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  return headers;
};

// Tunnel Stream Setup
const setupTunnelStream = async req => {
  return new Promise((resolve, reject) => {
    try {
      // Validate request
      const hostname = req.headers.host || reject(new Error("Invalid hostname"));
      const subdomain = extractSubdomain(hostname);
      const socket = getSocketForSubdomain(subdomain);

      // Reuse existing stream if valid
      if (hasValidExistingStream(req, subdomain)) {
        return resolve(req.connection.tunnelClientStream);
      }

      // Create new stream
      createNewTunnelStream(req, socket, subdomain, resolve);
    } catch (err) {
      console.error(`${new Date()}: Tunnel stream setup error:`, err);
      reject(err);
    }
  });
};
const extractSubdomain = hostname => {
  let subdomain = _tldjs.default.getSubdomain(hostname).toLowerCase();
  if (!subdomain) {
    throw new Error("Invalid subdomain");
  }
  if (serverOptions.subdomain) {
    subdomain = subdomain.replace(`.${serverOptions.subdomain}`, "");
  }
  return subdomain;
};
const getSocketForSubdomain = subdomain => {
  const socket = socketsBySubdomain[subdomain];
  if (!socket) {
    throw new Error(`${subdomain} is currently unregistered or offline.`);
  }
  return socket;
};
const hasValidExistingStream = (req, subdomain) => {
  const stream = req.connection.tunnelClientStream;
  return stream && !stream.destroyed && req.connection.subdomain === subdomain;
};
const createNewTunnelStream = (req, socket, subdomain, resolve) => {
  const streamId = (0, _uuid.v4)();
  (0, _socket.default)(socket).once(streamId, tunnelStream => {
    try {
      req.connection.subdomain = subdomain;
      req.connection.tunnelClientStream = tunnelStream;
      tunnelStream.pipe(req.connection);
      resolve(tunnelStream);
    } catch (err) {
      console.error(`${new Date()}: Stream creation error:`, err);
    }
  });
  socket.emit("incomingClient", streamId);
};

// Socket.IO Server Setup
const initializeSocketServer = httpServer => {
  const io = new _socket2.Server(httpServer);
  io.on("connection", socket => {
    socket.on("createTunnel", (name, callback) => {
      handleTunnelRegistration(socket, name, callback);
    });
    socket.on("disconnect", () => {
      handleTunnelDeregistration(socket);
    });
  });
};

// Tunnel Registration
const handleTunnelRegistration = (socket, requestedName, callback) => {
  if (socket.requestedName) return;
  const normalizedName = normalizeTunnelName(requestedName);
  if (!isValidTunnelName(normalizedName)) {
    rejectTunnel(socket, callback, "bad subdomain");
    return;
  }
  if (isTunnelNameTaken(normalizedName)) {
    rejectTunnel(socket, callback, "subdomain already claimed");
    return;
  }
  registerTunnel(socket, normalizedName, callback);
};
const normalizeTunnelName = name => {
  return name.toString().toLowerCase().replace(/[^0-9a-z-.]/g, "");
};
const isValidTunnelName = name => {
  return name.length > 0 && _validator.default.isURL(`${name}.example.com`);
};
const isTunnelNameTaken = name => {
  return !!socketsBySubdomain[name];
};
const rejectTunnel = (socket, callback, reason) => {
  console.log(`${new Date()}: Tunnel rejected - ${reason}`);
  if (callback) callback(reason);
  socket.disconnect();
};
const registerTunnel = (socket, name, callback) => {
  socketsBySubdomain[name] = socket;
  socket.requestedName = name;
  console.log(`${new Date()}: ${name} registered successfully`);
  if (callback) callback(null);
};
const handleTunnelDeregistration = socket => {
  if (socket.requestedName) {
    delete socketsBySubdomain[socket.requestedName];
    console.log(`${new Date()}: ${socket.requestedName} unregistered`);
  }
};
const handleServerError = (res, err) => {
  console.error(`${new Date()}: Server error:`, err);
  res.statusCode = 502;
  res.end(err.message);
};