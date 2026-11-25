#!/bin/sh
# The image's entrypoint: `setup` and `run` are the provider's two verbs (fastbridge-lp/setup.mjs); anything else is run as given, so the
# image still starts the daemon by default and a host's own command (a Render dockerCommand, `node fastbridge-lp/server.mjs --dry-run`) still works.
#   docker run -it -v tacit-lp:/var/lib/tacit-fastbridge-lp tacit-lp setup      make the key, ask the terms, wait for the funds, check, stop
#   docker run -d  -v tacit-lp:/var/lib/tacit-fastbridge-lp tacit-lp run        start it (and again after a restart)
case "$1" in
  setup) shift; exec node fastbridge-lp/setup.mjs setup --no-start "$@" ;;
  run|status|show-key) exec node fastbridge-lp/setup.mjs "$@" ;;
  *) exec "$@" ;;
esac
