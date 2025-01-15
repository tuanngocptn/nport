#!/usr/bin/env node
"use strict";

var _yargs = _interopRequireDefault(require("yargs"));
var _helpers = require("yargs/helpers");
var _serverService = _interopRequireDefault(require("./services/server.service.js"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
(0, _yargs.default)((0, _helpers.hideBin)(process.argv)).command("start [port]", "Start the server", yargs => {
  yargs.positional("port", {
    type: "number",
    default: 3000,
    describe: "The port to start the server on"
  });
}, _serverService.default).parse();