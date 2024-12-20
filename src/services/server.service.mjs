import { createServer } from "http";
import { Server } from "socket.io";

const server = (options) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello World\n");
  });

  const io = new Server(server);

  io.on("connection", (socket) => {
    console.log("a user connected");
  });

  server.listen(options.port, "127.0.0.1", () => {});

  console.log(
    `${new Date()}: nport server started on 127.0.0.1:${options.port}`
  );
};

export default server;
