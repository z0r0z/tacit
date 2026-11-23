#!/usr/bin/env python3
"""Keeps a fresh TacProvenOracle proof ready and serves it, on the GPU box that has tac-oracle-host built (prove-on-box.sh).

    ORACLE=0x... ELF=elf/tac_oracle ./serve-proofs.py

Every POLL seconds it reads the chain head and the oracle's STEP; when an interval newer than the proof it holds can be proven
(the keeper's rule, tools/tac-vault-keeper.mjs provenDue: (head - 1) / STEP - 1) it runs `tac-oracle-host input` and
`SP1_PROVER=cuda tac-oracle-host prove`, and keeps the result if its interval is the newer one. It holds no key and sends nothing:
whoever records the proof (the keeper, a page) checks it on chain.

    GET /proof.json   the newest proof ({ vkey, publicValues, proof, proofBytes }), 503 until there is one
    GET /status       { x, madeAt, provable, proving, lastError, lastSeconds }

With PUSH_URL (https://api.tacit.finance/oracle/proof) it also posts each new proof there, where the API checks it with the verifier contract
and serves it over https to the keeper (PROOF_URL) and the vault page; a box that cannot be reached from outside needs nothing else. Environment: ORACLE (required), ELF, HOST (default
./target/release/tac-oracle-host), DIR (work directory, default ./proofs), PORT (8787), POLL (15), RPC (comma list; default two public
nodes), SP1_PROVER (default cuda), BIND (default 0.0.0.0), PUSH_URL (unset: nothing is posted).
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ORACLE = os.environ.get("ORACLE", "").strip()
ELF = os.environ.get("ELF", "elf/tac_oracle")
HOST = os.environ.get("HOST", "./target/release/tac-oracle-host")
DIR = os.environ.get("DIR", "./proofs")
PORT = int(os.environ.get("PORT", "8787"))
POLL = int(os.environ.get("POLL", "15"))
BIND = os.environ.get("BIND", "0.0.0.0")
RPCS = [u.strip() for u in os.environ.get("RPC", "https://ethereum-rpc.publicnode.com,https://eth.drpc.org").split(",") if u.strip()]
PUSH_URL = os.environ.get("PUSH_URL", "").strip()
STEP_SEL = "0x53d0f255"  # STEP()

state = {"proof": None, "x": -1, "madeAt": None, "proving": False, "lastError": None, "lastSeconds": None, "provable": None,
         "pushedX": -1, "pushError": None}
lock = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def rpc(method, params):
    last = None
    for url in RPCS:
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         {"content-type": "application/json", "user-agent": "tac-oracle-prover"})
            j = json.load(urllib.request.urlopen(req, timeout=20))
            if "error" in j:
                raise RuntimeError(j["error"].get("message", "rpc error"))
            return j["result"]
        except Exception as e:  # try the next node
            last = e
    raise last


def proof_x(p):
    # the interval the proof is for: the low 32 bits of the public values' second word
    pv = p["publicValues"]
    return int(pv[2 + 128 - 8:2 + 128], 16)


def provable_now(step):
    head = int(rpc("eth_blockNumber", []), 16)
    return (head - 1) // step - 1


def reap_gpu_servers():
    """Stops every sp1-gpu-server on this box. tac-oracle-host leaves the GPU server it started running when it exits (its client is
    deliberately not dropped), and each one keeps its share of the GPU's memory, so after a few proofs the next one cannot start. Proofs run
    one at a time here, so none is in use between them."""
    try:
        pids = [int(d) for d in os.listdir("/proc") if d.isdigit()]
    except OSError:
        return
    for pid in pids:
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() == "sp1-gpu-server":
                    os.kill(pid, 9)
        except (OSError, ValueError):
            pass
    time.sleep(2)  # the memory is given back


def make_proof():
    os.makedirs(DIR, exist_ok=True)
    env = dict(os.environ, SP1_PROVER=os.environ.get("SP1_PROVER", "cuda"))
    t0 = time.time()
    subprocess.run([HOST, "input", "--oracle", ORACLE, "--dir", DIR], check=True, env=env, stdout=subprocess.DEVNULL, timeout=1500)
    reap_gpu_servers()
    try:
        subprocess.run([HOST, "prove", "--elf", ELF, "--dir", DIR], check=True, env=env, stdout=subprocess.DEVNULL, timeout=3000)
    finally:
        reap_gpu_servers()
    with open(os.path.join(DIR, "proof.json")) as f:
        p = json.load(f)
    return p, time.time() - t0


def push():
    """Posts the newest proof to PUSH_URL once; 409 (the API holds this interval or a newer one) counts as done."""
    with lock:
        p, x = state["proof"], state["x"]
    if not PUSH_URL or p is None or x <= state["pushedX"]:
        return
    body = json.dumps({"publicValues": p["publicValues"], "proof": p["proof"]}).encode()
    req = urllib.request.Request(PUSH_URL, body, {"content-type": "application/json", "user-agent": "tac-oracle-prover"})
    try:
        urllib.request.urlopen(req, timeout=30).read()
        done = True
    except urllib.error.HTTPError as e:
        done = e.code == 409
        err = f"HTTP {e.code} {e.read()[:120]!r}"
    except Exception as e:
        done, err = False, f"{type(e).__name__}: {e}"[:200]
    with lock:
        if done:
            state.update(pushedX=x, pushError=None)
        else:
            state["pushError"] = err
    log("pushed interval", x) if done else log("push failed:", err)


def worker():
    step = None
    while True:
        try:
            if step is None:
                step = int(rpc("eth_call", [{"to": ORACLE, "data": STEP_SEL}, "latest"]), 16)
                if step <= 0:
                    raise RuntimeError("STEP is zero: is ORACLE a TacProvenOracle?")
            prov = provable_now(step)
            with lock:
                state["provable"] = prov
                have = state["x"]
            if prov > have:
                with lock:
                    state["proving"] = True
                log("proving interval", prov, "(holding", have, ")")
                p, secs = make_proof()
                x = proof_x(p)
                with lock:
                    state["proving"] = False
                    state["lastSeconds"] = round(secs)
                    if x > state["x"]:
                        state.update(proof=p, x=x, madeAt=int(time.time()), lastError=None)
                        log("proof for interval", x, "ready in", round(secs), "s")
                    else:
                        log("proof for interval", x, "is not newer than", state["x"])
                push()
                continue  # the next interval may already be due: look again at once
            push()  # a proof that did not go out is sent again
        except Exception as e:
            with lock:
                state["proving"] = False
                state["lastError"] = f"{type(e).__name__}: {e}"[:300]
            log("error:", state["lastError"])
        time.sleep(POLL)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("access-control-allow-origin", "*")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        with lock:
            if path == "/proof.json":
                if state["proof"] is None:
                    return self._send(503, json.dumps({"error": "no proof yet", "provable": state["provable"], "proving": state["proving"]}))
                return self._send(200, json.dumps(state["proof"]))
            if path == "/status":
                return self._send(200, json.dumps({k: v for k, v in state.items() if k != "proof"}))
        self._send(404, json.dumps({"error": "not found"}))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if not (ORACLE.startswith("0x") and len(ORACLE) == 42):
        sys.exit("set ORACLE to the TacProvenOracle address")
    threading.Thread(target=worker, daemon=True).start()
    log("serving", f"{BIND}:{PORT}", "for oracle", ORACLE)
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
