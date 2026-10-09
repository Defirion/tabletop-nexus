# Nexus-only image: games are NOT baked in. They are bind-mounted read-only at
# /games and updated with deploy/update-game.sh, so a game change never
# rebuilds this image.
# Build context is the REPO ROOT:  docker compose -f deploy/compose.yaml up -d --build
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY public/ public/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NEXUS_CONFIG=/config/nexus.config.json

# The image's built-in unprivileged user. Games launched by Nexus inherit it.
USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
