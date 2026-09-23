# tacit-ipfs — self-hosted IPFS gateway

Runs a Kubo node that pins `index.html` and serves it over its own HTTP gateway,
so the loader does not depend on a third-party gateway.

`index.html` is a small loader: it calls `html()` on an ERC-8244 on-chain pointer
contract over public Ethereum RPCs and replaces itself with the returned
document. The gateway serves content-addressed bytes only (it does not fetch
arbitrary CIDs).

**What the hash check below does and does not cover.** It proves the gateway served
this loader and not something else. It says nothing about the document the loader
then becomes — those bytes come from an RPC at load time, and the loader runs their
scripts on this origin. Since this origin goes on to ask for the Tacit identity
signature, and that signature is the private key, a single lying RPC would otherwise
be a complete key-theft path. So the loader adopts a document only when two
independent providers return byte-identical results, and refuses to load at all if
they disagree. Treat any "providers disagree" message as a live incident, not a
glitch: do not sign anything on a page showing it.

Content CID: `QmbULJcE9VWFbpLuFynAF3anAzZBWMUxCkh3o7F47Do7ep` (recomputed after the quorum check was
added; the previously published `QmWZ3X8yBzZHrN5f5a5rnx4BZASpckck77khCBGKNXLRAb` addresses the older
first-success-wins loader and must not be served). Re-pin before the next deploy.

## Deploy on Render
1. Render dashboard → **New → Web Service** → this repo.
   - Runtime: **Docker**
   - Dockerfile path: `ipfs-gateway/Dockerfile`
   - Docker context: `ipfs-gateway`
   - (Optional) add a 1 GB disk mounted at `/data` so the peer identity and
     pinset survive restarts.
   Or point Render at `ipfs-gateway/render.yaml` (Blueprint) to set all of this.
2. After it goes live, the loader is served at:
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
