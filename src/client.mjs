#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import client from "./services/client.service.mjs";

yargs(hideBin(process.argv))
  .command(
    "* [port] [subdomain]",
    "Start the client",
    (yargs) => {
      yargs.positional("port", {
        type: "number",
        default: 3000,
        describe: "The port to start the server on",
      });
      yargs.positional("subdomain", {
        type: "string",
        default: "myapp",
        describe: "The subdomain to use",
      });
    },
    client
  )
  .parse();
