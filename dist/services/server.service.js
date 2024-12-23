"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _http = require("http");
var _socket = require("socket.io");
const server = options => {
  const server = (0, _http.createServer)((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });
    res.end("Hello World\n");
  });
  const io = new _socket.Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  io.on("connection", socket => {
    console.log("a user connected");
  });
  server.listen(options.port, "0.0.0.0", () => {
    console.log(`${new Date()}: nport server started on 0.0.0.0:${options.port}`);
  });
};
var _default = exports.default = server;