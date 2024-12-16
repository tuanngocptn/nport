// client api
const client = require('../client');

let api = {
  connect: (server, subdomain, port, hostname = '127.0.0.1') => {
    if (!server || !subdomain || !port || !hostname) {
      return Promise.reject(new Error('One or more options were not provided'));
    }

    let options = {
      server: server,
      subdomain: subdomain.toString(),
      port: port.toString(),
      hostname: hostname
    };

    // client returns a promise
    return client(options);
  }
};

module.exports = api;
