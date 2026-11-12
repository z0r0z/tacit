# The Tacit help desk gateway: one small web service. Build context is this folder (helpdesk/); Dockerfile path: deploy/Dockerfile.
# It runs the gateway (Node, no npm dependencies) and, beside it, llama.cpp's llama-server serving a 37 MB EMBEDDING model for retrieval. It runs no
# chat model: answers come from the community nodes that lease questions from it (LLM_URLS is empty).
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends nodejs git curl ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/*
# llama.cpp b12211 CPU build and the embedding model, both checked against pinned SHA-256 sums: the build stops on a mismatch.
ARG LLAMA_SHA=962924b5431bc1237a9e5d26ba072d37b6fe05f79b495206e7ff6134887624c5
ARG BGE_SHA=f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804
RUN curl -fsSL -C - --retry 8 --retry-delay 3 --retry-all-errors -o /tmp/llama.tgz https://github.com/ggml-org/llama.cpp/releases/download/b12211/llama-b12211-bin-ubuntu-x64.tar.gz \
 && echo "$LLAMA_SHA  /tmp/llama.tgz" | sha256sum -c - \
 && mkdir -p /opt/llama && tar -xzf /tmp/llama.tgz -C /opt/llama && rm /tmp/llama.tgz \
 && curl -fsSL -C - --retry 8 --retry-delay 3 --retry-all-errors -o /opt/bge.gguf https://huggingface.co/ggml-org/bge-small-en-v1.5-Q8_0-GGUF/resolve/main/bge-small-en-v1.5-q8_0.gguf \
 && echo "$BGE_SHA  /opt/bge.gguf" | sha256sum -c -
WORKDIR /app
COPY server.mjs backend.mjs lease.mjs scanfeed.mjs checkfeed.mjs reviewdigest.mjs retrieval.mjs guard.mjs build-corpus.mjs faq-check.mjs inbox.mjs bip39-english.txt persona.txt faq.json corpus.json ./
COPY codecheck/scan.mjs codecheck/lenses.mjs codecheck/mutate.mjs codecheck/roles.mjs ./codecheck/
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Defaults for a public deployment behind Render's proxy (the client is True-Client-IP, which the edge sets itself; else the second entry from the right of X-Forwarded-For, the one before the edge's own).
# A visitor waits up to LEASE_WAIT_MS (40 s, under the page's 45 s) for a node to answer: a laptop is slower than a GPU.
# Anything here can be overridden in the service's environment.
ENV HOST=0.0.0.0 DATA_DIR=/data LLM_URLS= TRUST_PROXY=1 TRUST_PROXY_HOPS=2 LEASE_WAIT_MS=40000 SCAN_FETCH=1 SCAN_REF=origin/main LD_LIBRARY_PATH=/opt/llama/llama-b12211
EXPOSE 10000
ENTRYPOINT ["/entrypoint.sh"]
