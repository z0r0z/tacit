# tacit-ipfs — self-hosted IPFS gateway

Runs a Kubo node that pins `index.html` and serves it over its own HTTP gateway.
Your gateway, your pin — no third-party content policy, gate, or upgrade wall.

Content CID: `QmWZ3X8yBzZHrN5f5a5rnx4BZASpckck77khCBGKNXLRAb`

## Deploy on Render
1. Commit `ipfs-gateway/` and push.
2. Render dashboard → **New → Web Service** → this repo.
   - Runtime: **Docker**
   - Dockerfile path: `ipfs-gateway/Dockerfile`
   - Docker context: `ipfs-gateway`
   - (Optional) add a 1 GB disk mounted at `/data` so the peer identity and
     pinset survive restarts.
   Or point Render at `ipfs-gateway/render.yaml` (Blueprint) to set all of this.
3. After it goes live, the dapp is served at:
   `https://<your-service>.onrender.com/ipfs/QmWZ3X8yBzZHrN5f5a5rnx4BZASpckck77khCBGKNXLRAb`
   Put your domain in front for a clean URL.

## Verify it's really serving your file (hash check, not a gateway 200)
```sh
CID=QmWZ3X8yBzZHrN5f5a5rnx4BZASpckck77khCBGKNXLRAb
curl -sL "https://<your-service>.onrender.com/ipfs/$CID" -o /tmp/x
ipfs add -Q --only-hash /tmp/x   # must print the CID above
```

## Serve a different / updated file
Replace `index.html`, rebuild/redeploy. The startup script prints the new CID
in the logs (`pinned: <cid>`); use that CID in the URL.

## Notes
- The write API (`:5001`) is bound to loopback only and never exposed.
- The node also announces the CID to the DHT, so public gateways
  (dweb.link, ipfs.io) can resolve it too once they pull from this node —
  but your own gateway URL above is the reliable path and works immediately.
