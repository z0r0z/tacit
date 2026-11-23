# The read-only gateway in front of our own nodes (gateway.mjs). No dependencies: Node's own http and fetch.
FROM node:20-alpine
WORKDIR /app
COPY gateway.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "--max-old-space-size=256", "gateway.mjs"]
