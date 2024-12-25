import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import ss from "socket.io-stream";

// association between subdomains and socket.io sockets
let socketsBySubdomain = {};

const server = (options) => {
  const server = createServer(requestListener);

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("a user connected");

    socket.on("CreateTunnel", (data, resCallBack) => {
      if (!data || !data.subdomain) {
        resCallBack?.("Invalid tunnel data");
        return socket.disconnect();
      }
      const { subdomain } = data;
      let subdomainNormalized = subdomain
        .toString()
        .toLowerCase()
        .replace(/[^0-9a-z-.]/g, "");

      if (socketsBySubdomain[subdomain]) {
        resCallBack?.("Subdomain already exists");
        return socket.disconnect();
      }
      socketsBySubdomain[subdomain] = socket;
      socket.requestedName = subdomainNormalized;
      resCallBack?.("Subdomain created");
    });

    socket.on("disconnect", () => {
      console.log("a user disconnected");
      delete socketsBySubdomain[socket.requestedName];
    });
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(
      `${new Date()}: nport server started on 0.0.0.0:${options.port}`
    );
  });
};

const requestListener = async (req, res) => {
  try {
    const tunnelClientStream = await getTunnelClientStream(req);
    const reqBodyChunks = [];

    req.on("error", (err) => {
      console.error(err.stack);
    });

    // collect body chunks
    req.on("data", (bodyChunk) => {
      reqBodyChunks.push(bodyChunk);
    });

    // proxy finalized request to tunnel stream
    req.on("end", () => {
      // make sure the client didn't die on us
      if (req.complete) {
        const reqLine = getReqLineFromReq(req);
        const headers = getHeadersFromReq(req);

        let reqBody = null;
        if (reqBodyChunks.length > 0) {
          reqBody = Buffer.concat(reqBodyChunks);
        }
        streamResponse(reqLine, headers, reqBody, tunnelClientStream);
      }
    });
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(error.message);
  }
};

const getReqLineFromReq = (req) => {
  return `${req.method} ${req.url} HTTP/${req.httpVersion}`;
};

const getHeadersFromReq = (req) => {
  const headers = [];

  for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
    headers.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
  }

  return headers;
};

const streamResponse = (reqLine, headers, reqBody, tunnelClientStream) => {
  tunnelClientStream.write(reqLine);
  tunnelClientStream.write("\r\n");
  tunnelClientStream.write(headers.join("\r\n"));
  tunnelClientStream.write("\r\n\r\n");
  if (reqBody) {
    console.log("helloooo 6");
    tunnelClientStream.write(reqBody);
  }
};

const getTunnelClientStream = async (req) => {
  let hostname = req.headers.host;
  if (!hostname) {
    throw new Error("Invalid hostname");
  }

  const subdomain = hostname.substring(
    0,
    hostname.lastIndexOf(`.${process.env.DOMAIN}`)
  );

  if (!subdomain) {
    console.log("Invalid subdomain");
    throw new Error("Invalid subdomain");
  }

  let subdomainSocket = socketsBySubdomain[subdomain];
  if (!subdomainSocket) {
    throw new Error(`${subdomain} is currently unregistered or offline.`);
  }

  if (
    req.connection.tunnelClientStream !== undefined &&
    !req.connection.tunnelClientStream.destroyed &&
    req.connection.subdomain === subdomain
  ) {
    return req.connection.tunnelClientStream;
  }

  const clientId = uuidv4();
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Tunnel stream connection timeout"));
    }, 5000); // 5 second timeout

    try {
      // First emit the incoming client event
      subdomainSocket.emit("IncomingClient", clientId);

      // Then wait for the stream
      ss(subdomainSocket).once(clientId, (tunnelClientStream) => {
        clearTimeout(timeout);
        req.connection.subdomain = subdomain;
        req.connection.tunnelClientStream = tunnelClientStream;
        
        // Handle stream errors
        tunnelClientStream.on('error', (err) => {
          console.error('Stream error:', err);
          tunnelClientStream.destroy();
        });

        tunnelClientStream.pipe(req.connection);
        resolve(tunnelClientStream);
      });
    } catch (error) {
      clearTimeout(timeout);
      console.error("Tunnel stream error:", error);
      reject(error);
    }
  });
};

export default server;
