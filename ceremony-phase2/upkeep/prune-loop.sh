#!/bin/sh
# on the coordinator's machine: every ten minutes, free disk by deleting chain files the mirror holds (see prune.py)
while :; do
  python3 /root/prune.py /root/chain --above 60 --to 45 --keep 3 >> /root/prune.log 2>&1
  sleep 600
done
