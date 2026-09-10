# Der Redekreis läuft auf der CPU; das Sprachmodell wird bewusst nicht ins
# Abbild gebacken (700 MB) sondern beim ersten Start in ein Volume geladen.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8123 \
    HOST=0.0.0.0 \
    MODELL_ORDNER=/models \
    MODELL_QUANT=Q8_0

WORKDIR /app

# Erst die Abhängigkeiten: so bleibt die Schicht über Codeänderungen hinweg gültig.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Alle Module, nicht einzeln aufgezählt — sonst fehlt beim nächsten neuen eines.
COPY *.mjs ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /models /app/transcripts \
 && chown -R node:node /models /app/transcripts

USER node
VOLUME ["/models", "/app/transcripts"]
EXPOSE 8123

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8123)+'/export.md').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
