"use strict";

var _yargs = _interopRequireDefault(require("yargs"));
var _helpers = require("yargs/helpers");
var _clientService = _interopRequireDefault(require("./services/client.service.js"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
(0, _yargs.default)((0, _helpers.hideBin)(process.argv)).command("* [port] [subdomain]", "Start the client", yargs => {
  yargs.positional("port", {
    type: "number",
    default: 3000,
    describe: "The port to start the server on"
  });
  yargs.positional("subdomain", {
    type: "string",
    default: "myapp",
    describe: "The subdomain to use"
  });
}, _clientService.default).parse();