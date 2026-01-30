# Use an official Node.js Alpine image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Install git and build tools required for dependencies (Alpine uses apk, not apt)
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    sqlite \
    sqlite-dev \
    curl

# Copy only dependency files first (better layer caching)
COPY package*.json ./
COPY pnpm-lock.yaml ./

# Install pnpm and then dependencies
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile

# Copy rest of the project files
COPY . .

# Expose app port (keep whatever your app actually listens on)
EXPOSE 6907

# Start the dev / app server
CMD ["npm", "run", "start"]
