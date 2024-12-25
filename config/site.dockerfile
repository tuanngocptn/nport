FROM node:22.12.0-slim
WORKDIR /app
COPY package.json .
COPY package-lock.json .
RUN npm install
RUN npm install -g http-server
COPY . .
EXPOSE 3000
ENTRYPOINT ["http-server", "-p", "8080", "/app/dist/website"]
