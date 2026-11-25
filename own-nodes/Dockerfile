# The read-only gateway in front of our own nodes (gateway.mjs). No dependencies: Node's own http and fetch.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
COPY gateway.mjs btc-index.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "--max-old-space-size=256", "gateway.mjs"]
