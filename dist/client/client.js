#!/usr/bin/env node
"use strict";

var _yargs = _interopRequireDefault(require("yargs"));
var _helpers = require("yargs/helpers");
var _clientService = _interopRequireDefault(require("./services/client.service.js"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
(0, _yargs.default)((0, _helpers.hideBin)(process.argv)).command("* [hostname]:[port] [subdomain]", "Start the client", yargs => {
  yargs.positional("port", {
    type: "number",
    default: 4000,
    describe: "The port to start the server on"
  });
  yargs.positional("subdomain", {
    type: "string",
    default: "myapp",
    describe: "The subdomain to use"
  });
  yargs.positional("hostname", {
    type: "string",
    default: "192.168.10.5",
    describe: "Address of local server for forwarding over NPort"
  });
}, options => (0, _clientService.default)({
  ...options,
  server: process.env.SERVER_URL
})).parse();