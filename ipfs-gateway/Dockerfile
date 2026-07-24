FROM ipfs/kubo:v0.41.0

# Bake the content to serve into the image so the node self-heals on redeploy.
COPY index.html /content/index.html
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

USER root
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
