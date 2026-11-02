# VoronMCP: bridge between Claude and a Klipper printer through Moonraker (Model Context Protocol)
FROM node:22-alpine

ENV NODE_ENV=production \
    CONFIG=/data/config.json \
    PORT=8080 \
    PUBLIC_PORT=8081

# tzdata so times in the activity list and backup names are local
RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# settings, the encrypted tokens, the activity list and backups are kept in /data (a volume, so they survive updates)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 8080: settings page and Claude Code on your network. 8081: the public port for a reverse proxy (exposed mode only)
EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
