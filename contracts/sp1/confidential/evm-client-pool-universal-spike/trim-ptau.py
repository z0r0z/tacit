#!/usr/bin/env python3
# Builds a byte-exact prefix view of a prepared power-22 ptau holding only what `snarkjs fflonk setup`
# reads (fflonk_setup.js): section 1 (header), the first NG1 tauG1 points of section 2, the first two tauG2
# points of section 3, and an empty section 12 (only its presence is checked). Every curve point is
# copied unchanged from the published file by HTTP range requests, so the resulting zkey is identical to
# one built from the full 4.8 GB file.
#   trim-ptau.py URL OUT NG1
import os, struct, sys, threading, time, urllib.request

url, out, NG1 = sys.argv[1], sys.argv[2], int(sys.argv[3])

def rng(a, n):
    for attempt in range(8):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={'Range': f'bytes={a}-{a + n - 1}'}), timeout=120)
            d = r.read()
            if len(d) == n:
                return d
        except Exception:
            pass
        time.sleep(2 + attempt)
    raise SystemExit(f'range {a}+{n} failed')

head = rng(0, 80)
assert head[:4] == b'ptau'
t1, s1 = struct.unpack_from('<IQ', head, 12)
assert (t1, s1) == (1, 44)
sec1 = head[24:24 + 44]
t2, s2 = struct.unpack_from('<IQ', head, 68)
assert t2 == 2 and s2 >= NG1 * 64, (t2, s2)
off3 = 80 + s2
h3 = rng(off3, 12 + 256)
t3, s3 = struct.unpack_from('<IQ', h3, 0)
assert t3 == 3

with open(out, 'wb') as f:
    f.write(b'ptau' + struct.pack('<II', 1, 4))
    f.write(struct.pack('<IQ', 1, 44) + sec1)
    f.write(struct.pack('<IQ', 2, NG1 * 64))
    data_off = f.tell()
    f.truncate(data_off + NG1 * 64)
    f.seek(data_off + NG1 * 64)
    f.write(struct.pack('<IQ', 3, 256) + h3[12:12 + 256])
    f.write(struct.pack('<IQ', 12, 0))

CH = 8 << 20
total = NG1 * 64
jobs = [(o, min(CH, total - o)) for o in range(0, total, CH)]
lock, done = threading.Lock(), [0]

def worker():
    fd = os.open(out, os.O_WRONLY)
    while True:
        with lock:
            if not jobs:
                break
            o, n = jobs.pop(0)
        os.pwrite(fd, rng(80 + o, n), data_off + o)
        with lock:
            done[0] += n
    os.close(fd)

t0 = time.time()
ts = [threading.Thread(target=worker) for _ in range(24)]
for t in ts:
    t.start()
while any(t.is_alive() for t in ts):
    time.sleep(15)
    print(f'{done[0] >> 20} / {total >> 20} MiB  {done[0] / (time.time() - t0) / 1e6:.1f} MB/s', flush=True)
print('done', os.path.getsize(out), f'{time.time() - t0:.0f}s')
