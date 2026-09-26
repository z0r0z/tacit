#!/usr/bin/env python3
# Parallel ranged download into a preallocated file: pget.py URL OUT [conns]
import os, sys, threading, time, urllib.request

url, out = sys.argv[1], sys.argv[2]
conns = int(sys.argv[3]) if len(sys.argv) > 3 else 16
size = int(urllib.request.urlopen(urllib.request.Request(url, method='HEAD')).headers['Content-Length'])
CH = 16 << 20
chunks = [(o, min(o + CH, size) - 1) for o in range(0, size, CH)]
with open(out, 'wb') as f:
    f.truncate(size)
lock, done = threading.Lock(), [0]

def worker():
    fd = os.open(out, os.O_WRONLY)
    while True:
        with lock:
            if not chunks:
                break
            a, b = chunks.pop(0)
        for attempt in range(8):
            try:
                req = urllib.request.Request(url, headers={'Range': f'bytes={a}-{b}'})
                data = urllib.request.urlopen(req, timeout=60).read()
                if len(data) != b - a + 1:
                    raise IOError('short read')
                os.pwrite(fd, data, a)
                with lock:
                    done[0] += len(data)
                break
            except Exception as e:
                time.sleep(2 + attempt)
        else:
            print('FAILED chunk', a, b, flush=True)
            os._exit(1)
    os.close(fd)

t0 = time.time()
ts = [threading.Thread(target=worker) for _ in range(conns)]
for t in ts:
    t.start()
while any(t.is_alive() for t in ts):
    time.sleep(15)
    print(f'{done[0] >> 20} / {size >> 20} MiB  {done[0] / (time.time() - t0) / 1e6:.1f} MB/s', flush=True)
for t in ts:
    t.join()
print('done', size, f'{time.time() - t0:.0f}s')
