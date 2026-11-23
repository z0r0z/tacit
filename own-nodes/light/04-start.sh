#!/bin/bash
# Start supervisor (it starts the light client, bitcoind and the gateway) and show their state. The instance's onstart runs the same line at every restart.
mkdir -p /var/log/tacit
pgrep -x supervisord >/dev/null || /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
sleep 20
supervisorctl status
curl -s -m 10 http://127.0.0.1:8080/health; echo
