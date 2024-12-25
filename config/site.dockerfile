FROM node:22.12.0-slim
WORKDIR /app
RUN npm install -g http-server
COPY . .
EXPOSE 3000
ENTRYPOINT ["http-server", "-p", "8080", "/usr/src/app"]
