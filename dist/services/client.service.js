"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _socket = _interopRequireDefault(require("socket.io-client"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const client = options => {
  const socket = (0, _socket.default)("http://127.0.0.1:3000");
  socket.on("connect", () => {
    console.log("Connected to server");
  });
  console.log("🚀 ~ options:", options);
};
var _default = exports.default = client;