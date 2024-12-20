import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import server from "./services/server.service.mjs";

yargs(hideBin(process.argv))
  .command(
    "start [port]",
    "Start the server",
    (yargs) => {
      yargs.positional("port", {
        type: "number",
        default: 3000,
        describe: "The port to start the server on",
      });
    },
    server
  )
  .parse();
