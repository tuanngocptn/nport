import Client from "socket.io-client";

const client = (options) => {
  const socket = Client("http://127.0.0.1:3000");
  socket.on("connect", () => {
    console.log("Connected to server");
  });
  console.log("🚀 ~ options:", options);
};

export default client;
