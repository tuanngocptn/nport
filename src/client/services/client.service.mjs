import Client from "socket.io-client";
import net from "net";
import ss from "socket.io-stream";

const IDLE_SOCKET_TIMEOUT_MILLISECONDS = 1000 * 30;

const client = async (options) => {
  const socket = Client(process.env.SERVER_URL);
  socket.on("connect", () => {
    console.log(new Date() + `: Connected ${process.env.SERVER_URL}`);
    console.log(
      new Date() +
        `: Requesting subdomain '${options["subdomain"]}' via '${options["server"]}'`
    );

    socket.emit(
      "CreateTunnel",
      {
        subdomain: options["subdomain"],
        server: options["server"],
      },
      (response) => {
        console.log(new Date() + `: Response ${response}`);
      }
    );
  });

  socket.on("IncomingClient", (clientId) => {
    const client = net.connect(options.port, options.hostname, () => {
      const socket = ss.createStream();
      socket.pipe(client).pipe(socket);
      socket.on("end", () => {
        client.destroy();
      });
      ss(socket).emit(clientId, socket);
    });

    client.setTimeout(IDLE_SOCKET_TIMEOUT_MILLISECONDS);
    client.on("timeout", () => {
      console.log("🚀 ~ timeout:")
      client.end();
    });

    client.on("error", (err) => {
      console.log("🚀 ~ error:", err.message);
      // handle connection refusal (create a stream and immediately close it)
      const socket = ss.createStream();
      ss(socket).emit(clientId, socket);
      socket.end();
    });
  });
};

export default client;
