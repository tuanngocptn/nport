'use strict';

const IDLE_SOCKET_TIMEOUT_MILLISECONDS = 1000 * 30;

module.exports = (options) => {
  return new Promise((resolve, reject) => {
    // require the things we need
    const net = require('net');
    const ss = require('socket.io-stream');
    let socket = require('socket.io-client')(options['server']);

    socket.on('connect', () => {
      console.log(new Date() + ': connected');
      console.log(new Date() + ': requesting subdomain ' + options['subdomain'] + ' via ' + options['server']);

      socket.emit('createTunnel', options['subdomain'], (err) => {
        if (err) {
          console.log(new Date() + ': [error] ' + err);

          reject(err);
        } else {
          console.log(new Date() + ': registered with server successfully');
          console.log(new Date() + ': your domain is: https://' + options['subdomain'] + '.nport.link');

          // clean and concat requested url
          let url;
          let subdomain = options['subdomain'].toString();
          let server = options['server'].toString();

          if (server.includes('https://')) {
            url = `https://${subdomain}.${server.slice(8)}`;
          } else if (server.includes('http://')) {
            url = `http://${subdomain}.${server.slice(7)}`;
          } else {
            url = `https://${subdomain}.${server}`;
          }

          // resolve promise with requested URL
          resolve(url);
        }
      });
    });

    socket.on('incomingClient', (clientId) => {
      let client = net.connect(options['port'], options['hostname'], () => {
        let s = ss.createStream();
        s.pipe(client).pipe(s);

        s.on('end', () => {
          client.destroy();
        });

        ss(socket).emit(clientId, s);
      });

      client.setTimeout(IDLE_SOCKET_TIMEOUT_MILLISECONDS);
      client.on('timeout', () => {
        client.end();
      });

      client.on('error', () => {
        // handle connection refusal (create a stream and immediately close it)
        let s = ss.createStream();
        ss(socket).emit(clientId, s);
        s.end();
      });
    });
  });
};
