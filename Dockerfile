FROM node:22-slim

# better-sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY src/ ./src/
COPY config/ ./config/
COPY persona-packs/ ./persona-packs/
COPY tsconfig.json ./

# Default persona and user (override via volumes)
COPY persona-example/ ./persona-example/
COPY user/ ./user/

RUN mkdir -p data

EXPOSE 18080 18090

CMD ["node", "--experimental-strip-types", "src/index.ts"]
