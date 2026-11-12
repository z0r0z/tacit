let audio = null, styled = false;
const CSS = `.rpop{position:fixed;z-index:2147483000;width:0;height:0;pointer-events:none}
.rpop b{position:absolute;left:0;top:0;display:grid;justify-items:center;transform:translate(-50%,-50%);font:600 26px/1 var(--mono,ui-monospace,monospace);letter-spacing:-.02em;color:var(--ok,#1f8a4c);white-space:nowrap;text-shadow:0 1px 0 color-mix(in srgb,var(--card,#fff) 70%,transparent);will-change:transform,opacity}
.rpop b small{font:500 11px/1.4 var(--mono,ui-monospace,monospace);letter-spacing:.02em;opacity:.8}
.rpop svg{position:absolute;left:-13px;top:-13px;width:26px;height:26px;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.18);will-change:transform,opacity}`;

export function chime() {
  try { if (localStorage.getItem('tacit-chime') === 'off') return; } catch { }
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime + 0.01, out = audio.createGain();
    out.gain.value = 0.07; out.connect(audio.destination);
    for (const [hz, at] of [[880, 0], [1318.5, 0.085]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(1, t0 + at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.6);
      o.connect(g); g.connect(out); o.start(t0 + at); o.stop(t0 + at + 0.65);
    }
  } catch { }
}

export function rewardPop(anchor, { pts, sound = true } = {}) {
  const n = Math.round(Number(pts) || 0);
  if (n < 1 || !anchor?.isConnected || document.hidden) return;
  if (!styled) { styled = true; document.head.append(Object.assign(document.createElement('style'), { textContent: CSS })); }
  const r = anchor.getBoundingClientRect(), calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = document.createElement('div');
  box.className = 'rpop'; box.setAttribute('aria-hidden', 'true');
  box.style.left = `${r.left + r.width / 2}px`; box.style.top = `${r.top}px`;
  const coins = calm ? 0 : 7;
  box.innerHTML = `<b>+${n.toLocaleString('en-US')}<small>TAC points</small></b>${'<svg aria-hidden="true"><use href="#tk-tac"/></svg>'.repeat(coins)}`;
  document.body.append(box);
  if (sound) chime();
  const label = box.firstElementChild, ease = 'cubic-bezier(.2,.8,.2,1)', easeIn = 'cubic-bezier(.5,0,.75,0)';
  const runs = [label.animate(calm
    ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
    : [{ opacity: 0, transform: 'translate(-50%,-40%) scale(.6)', easing: ease }, { opacity: 1, transform: 'translate(-50%,-150%) scale(1.1)', offset: 0.16, easing: ease },
       { opacity: 1, transform: 'translate(-50%,-190%) scale(1)', offset: 0.32 }, { opacity: 1, transform: 'translate(-50%,-230%) scale(1)', offset: 0.75, easing: easeIn },
       { opacity: 0, transform: 'translate(-50%,-290%) scale(.97)' }],
    { duration: calm ? 1700 : 1800, fill: 'forwards' })];
  [...box.querySelectorAll('svg')].forEach((c, i) => {
    const a = (-162 + (144 / (coins - 1)) * i + (Math.random() * 14 - 7)) * (Math.PI / 180), d = 78 + Math.random() * 48;
    const x = Math.cos(a) * d, y = Math.sin(a) * d - 12, spin = (Math.random() < 0.5 ? -1 : 1) * (140 + Math.random() * 180);
    runs.push(c.animate([
      { opacity: 0, transform: 'translate(0,0) scale(.3) rotate(0)', easing: ease },
      { opacity: 1, transform: `translate(${x * 0.8}px,${y * 0.8}px) scale(1.05) rotate(${spin / 2}deg)`, offset: 0.35 },
      { opacity: 1, transform: `translate(${x}px,${y + 8}px) scale(1) rotate(${spin * 0.8}deg)`, offset: 0.62, easing: easeIn },
      { opacity: 0, transform: `translate(${x * 1.08}px,${y + 40}px) scale(.85) rotate(${spin}deg)` },
    ], { duration: 1150 + Math.random() * 300, delay: i * 30, fill: 'forwards' }));
  });
  Promise.all(runs.map((a) => a.finished)).catch(() => {}).finally(() => box.remove());
}
