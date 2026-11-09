#!/bin/sh
# Starts the embedding server, refreshes the docs the help desk answers from, then the gateway.
set -u
mkdir -p "$DATA_DIR"
/opt/llama/llama-b12211/llama-server -m /opt/bge.gguf --embedding -c 512 -b 512 -ub 512 --host 127.0.0.1 --port 8090 > /tmp/embedding.log 2>&1 &
# The public repository: the docs the answers come from, and (with SCAN_REPO_URL) the code the community nodes review.
if [ -n "${SCAN_REPO_URL:-}" ]; then
  [ -d "$DATA_DIR/repo/.git" ] || git clone --depth 50 --no-checkout --filter=blob:limit=500k --quiet "$SCAN_REPO_URL" "$DATA_DIR/repo" || echo "could not clone $SCAN_REPO_URL; serving the docs baked into the image"
  git -C "$DATA_DIR/repo" fetch --quiet --no-tags origin 2>/dev/null || true
  if [ -d "$DATA_DIR/repo/.git" ]; then
    export SCAN_REPO="$DATA_DIR/repo"
    # Rebuild the corpus from the repository's current docs, and check every FAQ fact against it: a FAQ that no longer matches the docs is not served.
    if REPO="$DATA_DIR/repo" node build-corpus.mjs /tmp/corpus.json "$SCAN_REF" > /tmp/corpus.log 2>&1; then
      cp /tmp/corpus.json /app/corpus.json; cat /tmp/corpus.log
      node faq-check.mjs /app/corpus.json /app/faq.json || { echo "THE FAQ NO LONGER MATCHES THE DOCS: serving without it until it is reviewed"; export FAQ=off; }
    else echo "corpus rebuild failed ($(tail -1 /tmp/corpus.log)); serving the docs baked into the image"; fi
  fi
fi
# The gateway needs the embedding server for the first retrieval (it caches the vectors in DATA_DIR afterwards).
for i in $(seq 1 90); do curl -sf http://127.0.0.1:8090/health > /dev/null && break; sleep 1; done
export PORT="${PORT:-10000}"
exec node server.mjs serve
