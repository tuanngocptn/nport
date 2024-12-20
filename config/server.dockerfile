# Use the Node.js v22.12.0 base image
FROM node:22.12.0-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the application's default port
EXPOSE 3000

# Default command (overwritten by docker-compose command)
CMD ["node", "src/server.mjs"]