import Client from "socket.io-client";
import net from "net";
import ss from "socket.io-stream";

const IDLE_SOCKET_TIMEOUT_MILLISECONDS = 1000 * 30;

const client = async (options) => {
  const socket = Client(process.env.SERVER_URL);

  socket.on("connect_error", (error) => {
    console.error(new Date() + ": Connection error:", error);
  });

  socket.on("disconnect", (reason) => {
    console.log(new Date() + ": Disconnected:", reason);
    if (reason === "io server disconnect") {
      socket.connect();
    }
  });

  socket.on("connect", () => {
    console.log(new Date() + `: Connected ${process.env.SERVER_URL}`);
    const createTunnel = () => {
      socket.emit(
        "CreateTunnel",
        {
          subdomain: options["subdomain"],
          server: options["server"],
        },
        (response) => {
          console.log(new Date() + `: Response ${response}`);
          if (response === "Subdomain already exists") {
            setTimeout(createTunnel, 5000);
          }
        }
      );
    };
    createTunnel();
  });

  socket.on("IncomingClient", (clientId) => {
    const client = net.connect(options.port, options.hostname, () => {
      const stream = ss.createStream();

      stream.on("error", (err) => {
        console.error("Stream error:", err);
        stream.destroy();
        client.destroy();
      });

      client.on("error", (err) => {
        console.error("Client error:", err);
        stream.destroy();
        client.destroy();
      });

      ss(socket).emit(clientId, stream, (error) => {
        if (error) {
          console.error("Stream creation error:", error);
          stream.destroy();
          client.destroy();
          return;
        }
        client.pipe(stream).pipe(client);
      });
    });

    client.setTimeout(IDLE_SOCKET_TIMEOUT_MILLISECONDS);
    client.on("timeout", () => {
      console.log("Connection timeout - closing socket");
      client.end();
    });

    client.on("error", (err) => {
      console.error("Connection error:", err.message);
      const errorStream = ss.createStream();
      ss(socket).emit(clientId, errorStream);
      errorStream.end();
    });
  });
};

export default client;
