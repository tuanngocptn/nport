'use strict';

module.exports = (options) => {
  // libs
  const http = require('http');
  const tldjs = require('tldjs');
  const ss = require('socket.io-stream');
  const uuid = require('uuid/v4');
  const isValidDomain = require('is-valid-domain');

  // association between subdomains and socket.io sockets
  let socketsBySubdomain = {};

  // bounce incoming http requests to socket.io
  let server = http.createServer(async (req, res) => {
    getTunnelClientStreamForReq(req).then((tunnelClientStream) => {
      const reqBodyChunks = [];

      req.on('error', (err) => {
        console.error(err.stack);
      });

      // collect body chunks
      req.on('data', (bodyChunk) => {
        reqBodyChunks.push(bodyChunk);
      });

      // proxy finalized request to tunnel stream
      req.on('end', () => {
        // make sure the client didn't die on us
        if (req.complete) {
          const reqLine = getReqLineFromReq(req);
          const headers = getHeadersFromReq(req);

          let reqBody = null;
          if (reqBodyChunks.length > 0) {
            reqBody = Buffer.concat(reqBodyChunks);
          }

          streamResponse(reqLine, headers, reqBody, tunnelClientStream);
        }
      });
    }).catch((subdomainErr) => {
      res.statusCode = 502;
      return res.end(subdomainErr.message);
    });
  });

  // HTTP upgrades (i.e. websockets) are NOT currently supported because socket.io relies on them
  // server.on('upgrade', (req, socket, head) => {
  //   getTunnelClientStreamForReq(req).then((tunnelClientStream) => {
  //     tunnelClientStream.on('error', () => {
  //       req.destroy();
  //       socket.destroy();
  //       tunnelClientStream.destroy();
  //     });

  //     // get the upgrade request and send it to the tunnel client
  //     let messageParts = getHeaderPartsForReq(req);

  //     messageParts.push(''); // Push delimiter

  //     let message = messageParts.join('\r\n');
  //     tunnelClientStream.write(message);

  //     // pipe data between ingress socket and tunnel client
  //     tunnelClientStream.pipe(socket).pipe(tunnelClientStream);
  //   }).catch((subdomainErr) => {
  //     // if we get an invalid subdomain, this socket is most likely being handled by the root socket.io server
  //     if (!subdomainErr.message.includes('Invalid subdomain')) {
  //       socket.end();
  //     }
  //   });
  // });

  function getTunnelClientStreamForReq (req) {
    return new Promise((resolve, reject) => {
      // without a hostname, we won't know who the request is for
      let hostname = req.headers.host;
      if (!hostname) {
        return reject(new Error('Invalid hostname'));
      }

      // make sure we received a subdomain
      let subdomain = tldjs.getSubdomain(hostname).toLowerCase();
      if (!subdomain) {
        return reject(new Error('Invalid subdomain'));
      }

      // tldjs library return subdomain as all subdomain path from the main domain.
      // Example:
      // 1. super.example.com = super
      // 2. my.super.example.com = my.super
      // 3. If we are running the tunnel server on a subdomain, we must strip it from the provided hostname
      if (options.subdomain) {
        subdomain = subdomain.replace(`.${options.subdomain}`, '');
      }

      let subdomainSocket = socketsBySubdomain[subdomain];
      if (!subdomainSocket) {
        return reject(new Error(`${subdomain} is currently unregistered or offline.`));
      }

      if (req.connection.tunnelClientStream !== undefined && !req.connection.tunnelClientStream.destroyed && req.connection.subdomain === subdomain) {
        return resolve(req.connection.tunnelClientStream);
      }

      let requestGUID = uuid();
      ss(subdomainSocket).once(requestGUID, (tunnelClientStream) => {
        req.connection.subdomain = subdomain;
        req.connection.tunnelClientStream = tunnelClientStream;

        // Pipe all data from tunnel stream to requesting connection
        tunnelClientStream.pipe(req.connection);

        resolve(tunnelClientStream);
      });

      subdomainSocket.emit('incomingClient', requestGUID);
    });
  }

  function getReqLineFromReq (req) {
    return `${req.method} ${req.url} HTTP/${req.httpVersion}`;
  }

  function getHeadersFromReq (req) {
    const headers = [];

    for (let i = 0; i < (req.rawHeaders.length - 1); i += 2) {
      headers.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    }

    return headers;
  }

  function streamResponse (reqLine, headers, reqBody, tunnelClientStream) {
    tunnelClientStream.write(reqLine);
    tunnelClientStream.write('\r\n');
    tunnelClientStream.write(headers.join('\r\n'));
    tunnelClientStream.write('\r\n\r\n');
    if (reqBody) {
      tunnelClientStream.write(reqBody);
    }
  }

  // socket.io instance
  let io = require('socket.io')(server);
  io.on('connection', (socket) => {
    socket.on('createTunnel', (requestedName, responseCb) => {
      if (socket.requestedName) {
        // tunnel has already been created
        return;
      }

      // domains are case insensitive
      let reqNameNormalized = requestedName.toString().toLowerCase().replace(/[^0-9a-z-.]/g, '');

      // make sure the client is requesting a valid subdomain
      if (reqNameNormalized.length === 0 || !isValidDomain(`${reqNameNormalized}.example.com`)) {
        console.log(new Date() + ': ' + reqNameNormalized + ' -- bad subdomain. disconnecting client.');
        if (responseCb) {
          responseCb('bad subdomain');
        }
        return socket.disconnect();
      }

      // make sure someone else hasn't claimed this subdomain
      if (socketsBySubdomain[reqNameNormalized]) {
        console.log(new Date() + ': ' + reqNameNormalized + ' requested but already claimed. disconnecting client.');
        if (responseCb) {
          responseCb('subdomain already claimed');
        }
        return socket.disconnect();
      }

      // store a reference to this socket by the subdomain claimed
      socketsBySubdomain[reqNameNormalized] = socket;
      socket.requestedName = reqNameNormalized;
      console.log(new Date() + ': ' + reqNameNormalized + ' registered successfully');

      if (responseCb) {
        responseCb(null);
      }
    });

    // when a client disconnects, we need to remove their association
    socket.on('disconnect', () => {
      if (socket.requestedName) {
        delete socketsBySubdomain[socket.requestedName];
        console.log(new Date() + ': ' + socket.requestedName + ' unregistered');
      }
    });
  });

  // http server
  server.listen(options.port, options.hostname);

  console.log(`${new Date()}: socket-tunnel server started on ${options.hostname}:${options.port}`);
};
