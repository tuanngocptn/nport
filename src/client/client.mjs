#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import client from "./services/client.service.mjs";

yargs(hideBin(process.argv))
  .command(
    "* [hostname]:[port] [subdomain]",
    "Start the client",
    (yargs) => {
      yargs.positional("port", {
        type: "number",
        default: 4000,
        describe: "The port to start the server on",
      });
      yargs.positional("subdomain", {
        type: "string",
        default: "myapp",
        describe: "The subdomain to use",
      });
      yargs.positional("hostname", {
        type: "string",
        default: "192.168.10.5",
        describe: "Address of local server for forwarding over NPort",
      });
    },
    (options) => client({ ...options, server: process.env.SERVER_URL })
  )
  .parse();
