const socketTunnel = require('../lib/api');

socketTunnel.connect('https://domain.example', 'deviceSubdomain', '2222')
  .then((url) => {
    console.log(url);
  })
  .catch((err) => {
    console.error(err);
  });
