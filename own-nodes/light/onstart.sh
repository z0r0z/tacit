#!/bin/bash
# onstart for the light-node box: runs at every (re)start of the instance. Everything lives under supervisor.
mkdir -p /var/log/tacit
pgrep -x supervisord >/dev/null || /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
