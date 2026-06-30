#!/usr/bin/env bash
# Runs ON ssh6: clone ssh8's working prover env (toolchain + repo + built ELFs + prove bins) so ssh6 has
# the IDENTICAL toolchain (same vkeys) and can prove immediately with its large uncapped RAM.
{
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 && apt-get install -y rsync openssh-client >/dev/null 2>&1
  S8="root@ssh8.vast.ai"
  SSHO="ssh -p 27240 -i /root/.ssh/vast_prover -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=20"
  echo "=== clone toolchain + repo from ssh8 (this box has 684G RAM, 255 cores) ==="
  rsync -az -e "$SSHO" "$S8:/root/.sp1"        /root/   && echo "ok .sp1"
  rsync -az -e "$SSHO" "$S8:/root/.cargo"      /root/   && echo "ok .cargo"
  rsync -az -e "$SSHO" "$S8:/usr/local/go"     /usr/local/ && echo "ok go"
  rsync -az -e "$SSHO" "$S8:/root/work"        /root/   && echo "ok work"
  echo "=== CLONE_DONE ==="
  du -sh /root/.sp1 /root/.cargo /root/work/cxfer 2>/dev/null
} > /root/clone.log 2>&1
