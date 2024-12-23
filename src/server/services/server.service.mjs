import { createServer } from "http";
import { Server } from "socket.io";

const server = (options) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello World\n");
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("a user connected");
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(
      `${new Date()}: nport server started on 0.0.0.0:${options.port}`
    );
  });
};

export default server;
