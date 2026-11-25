# romanz/electrs (the light Electrum-protocol index, tens of GB; not Blockstream's esplora index, ~1 TB), built from a pinned commit. There is no
# official image; the build checks out the release tag and FAILS unless it resolves to the pinned commit (a git commit id names its whole tree).
#
# Bumping: set ELECTRS_TAG and ELECTRS_COMMIT (`git rev-parse <tag>^{commit}` in a clone of github.com/romanz/electrs). v0.12.1 = 2026-11-10.
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0 AS build
ARG ELECTRS_TAG=v0.12.1
ARG ELECTRS_COMMIT=d0aa1c30b6f5285f01d89ff6c85e8a6046b226ee
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cargo build-essential libclang-dev librocksdb-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN set -eux; git clone --depth 1 --branch "$ELECTRS_TAG" https://github.com/romanz/electrs.git; cd electrs; \
    test "$(git rev-parse HEAD)" = "$ELECTRS_COMMIT"
ENV ROCKSDB_INCLUDE_DIR=/usr/include ROCKSDB_LIB_DIR=/usr/lib
RUN cd electrs && cargo install --locked --path . --root /out

FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update && apt-get install -y --no-install-recommends librocksdb9.10 && rm -rf /var/lib/apt/lists/* && useradd -u 1001 -m electrs
COPY --from=build /out/bin/electrs /usr/local/bin/electrs
USER electrs
ENTRYPOINT ["electrs", "--conf", "/etc/electrs/config.toml"]
