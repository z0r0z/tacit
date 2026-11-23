# Bitcoin Core, built from the release tarball that THIS BUILD verifies: the tarball must match the pinned sha256 AND the signed
# SHA256SUMS list, and that list must carry good signatures from at least five distinct Bitcoin Core builder keys (the keys come from
# bitcoin-core/guix.sigs at a pinned commit). The Docker Hub images of Bitcoin Core are unofficial and say so; this node feeds our
# services chain data, so the binary is checked here rather than trusted.
#
# Bumping: set BTC_VERSION, read the x86_64 line of https://bitcoincore.org/bin/bitcoin-core-<v>/SHA256SUMS into BTC_SHA256, and move
# SIGS_COMMIT to the current head of bitcoin-core/guix.sigs. The build fails (it does not warn) when any of the checks does.
FROM debian:bookworm-slim AS fetch
ARG BTC_VERSION=30.5
ARG BTC_SHA256=593de13690ea3ef15e7ac3a695cc60ca9c2d576a184aeec69c69f458c7707568
ARG SIGS_COMMIT=93aacee89333de43a96e7d128baa84e737c41b0b
ARG MIN_GOOD=5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && rm -rf /var/lib/apt/lists/*
WORKDIR /w
RUN set -eux; \
    T="bitcoin-${BTC_VERSION}-x86_64-linux-gnu.tar.gz"; B="https://bitcoincore.org/bin/bitcoin-core-${BTC_VERSION}"; \
    curl -fsSLO "$B/$T"; curl -fsSLO "$B/SHA256SUMS"; curl -fsSLO "$B/SHA256SUMS.asc"; \
    echo "${BTC_SHA256}  $T" | sha256sum -c -; \
    grep " $T\$" SHA256SUMS | sha256sum -c -; \
    curl -fsSL "https://codeload.github.com/bitcoin-core/guix.sigs/tar.gz/${SIGS_COMMIT}" | tar xz; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --import guix.sigs-*/builder-keys/*.gpg 2>/dev/null; \
    GOOD="$(gpg --batch --status-fd 1 --verify SHA256SUMS.asc SHA256SUMS 2>/dev/null | awk '$2=="VALIDSIG"{print $3}' | sort -u | wc -l)"; \
    echo "good builder signatures: $GOOD"; \
    [ "$GOOD" -ge "${MIN_GOOD}" ]; \
    tar xzf "$T"; mv "bitcoin-${BTC_VERSION}" /bitcoin

FROM debian:bookworm-slim
RUN useradd -u 1000 -m bitcoin
COPY --from=fetch /bitcoin/bin/bitcoind /bitcoin/bin/bitcoin-cli /usr/local/bin/
USER bitcoin
VOLUME /data
EXPOSE 8333
ENTRYPOINT ["bitcoind", "-datadir=/data"]
