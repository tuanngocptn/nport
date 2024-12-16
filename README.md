# **NPort**

NPort is a **Node.js-based tool** that tunnels HTTP connections through **Socket.IO** streams, enabling you to expose local servers via public URLs easily and securely. It is particularly useful for **development environments**, testing webhooks, and sharing projects on local servers.

---

## **Features**

- **HTTP Tunneling**: Expose your local HTTP server to the internet using Socket.IO-based tunnels.
- **Secure and Lightweight**: A minimal, fast, and secure way to share your server without requiring complicated infrastructure.
- **Custom Subdomains**: Access your local server using easy-to-read public URLs.
- **WebSocket Support**: Handles WebSocket connections seamlessly.
- **Cross-Platform**: Works on Linux, macOS, and Windows systems.

---

## **Install**

```sh
# install nport from npm

npm i nport # local install

npm i -g nport # global install

# alternative: install from github

npm install git+https://github.com/tuanngocptn/nport.git # local install

npm install -g git+https://github.com/tuanngocptn/nport.git  # global install
```

---

## **How to use**

```sh
npx nport -s xxx -p 3000 # https://xxx.nport.link (local install)

nport -s xxx -p 3000 # https://xxx.nport.link (global install)
```
**OR**

```sh
npx nport --server https://nport.link --subdomain xxx --hostname 127.0.0.1 --port 3000 # https://xxx.nport.link (local install)

nport --server https://nport.link --subdomain xxx --hostname 127.0.0.1 --port 3000 # https://xxx.nport.link (global install)
```

# Source from socket-tunnel

Tunnel HTTP connections via socket.io streams. Inspired by [localtunnel](https://github.com/localtunnel/localtunnel).

## Blog Post

[Read all about it](https://ericbarch.com/post/sockettunnel/)