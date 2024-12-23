import Client from "socket.io-client";

console.log(process.env.BASE_URL);

const client = (options) => {
  const socket = Client(process.env.BASE_URL);
  socket.on("connect", () => {
    console.log("Connected to server");
  });
  console.log("🚀 ~ options:", options);
};

export default client;
