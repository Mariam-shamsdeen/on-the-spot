// On the Spot — floating 3D stationery, shared by the staff app and the customer page
(() => {
  // ================= 3D stationery (SVG) =================
  let objId = 0;
  const OBJ = {
    pencil: () => { const g = 'pg' + objId++; return `<svg width="300" height="60" viewBox="0 0 300 60"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD36B"/><stop offset=".5" stop-color="#FFB547"/><stop offset="1" stop-color="#D98A1C"/></linearGradient></defs><rect x="40" y="8" width="210" height="44" rx="6" fill="url(#${g})"/><rect x="40" y="27" width="210" height="6" fill="#E89F2A" opacity=".5"/><rect x="250" y="8" width="28" height="44" fill="#C9C9D6"/><rect x="254" y="8" width="4" height="44" fill="#E6E6EF"/><rect x="276" y="8" width="20" height="44" rx="8" fill="#FF7AA8"/><path d="M40 8 L4 30 L40 52Z" fill="#F2D3A6"/><path d="M14 24 L4 30 L14 36Z" fill="#2B2440"/></svg>`; },
    notebook: () => `<svg width="190" height="240" viewBox="0 0 190 240"><rect x="6" y="6" width="190" height="240" rx="14" fill="#5B3FD1" transform="translate(-6,-6)"/><rect width="184" height="234" rx="14" fill="#8B6CFF"/><rect x="18" width="10" height="234" fill="#6F50E6"/><rect x="45" y="40" width="120" height="70" rx="8" fill="#fff" opacity=".96"/><rect x="58" y="58" width="80" height="8" rx="4" fill="#8B6CFF"/><rect x="58" y="78" width="60" height="8" rx="4" fill="#C9BCFF"/></svg>`,
    plane: () => `<svg width="170" height="120" viewBox="0 0 170 120"><path d="M0 60 L170 0 L120 120 L80 75Z" fill="#fff"/><path d="M80 75 L170 0 L95 95Z" fill="#DCD6F5"/><path d="M80 75 L95 95 L88 112Z" fill="#B9B0E0"/></svg>`,
    sheet: () => `<svg width="150" height="190" viewBox="0 0 150 190"><rect width="150" height="190" rx="8" fill="#fff"/><rect x="18" y="24" width="100" height="10" rx="5" fill="#FF5E9C"/><rect x="18" y="48" width="114" height="6" rx="3" fill="#E4E0F2"/><rect x="18" y="62" width="114" height="6" rx="3" fill="#E4E0F2"/><rect x="18" y="76" width="90" height="6" rx="3" fill="#E4E0F2"/><rect x="18" y="100" width="114" height="60" rx="6" fill="#FFB547" opacity=".9"/></svg>`,
    pen: () => `<svg width="70" height="230" viewBox="0 0 70 230"><rect x="15" y="0" width="40" height="160" rx="10" fill="#3D7BFF"/><rect x="15" y="0" width="12" height="160" rx="6" fill="#6B9BFF" opacity=".6"/><rect x="15" y="20" width="40" height="18" fill="#1E4FCC"/><rect x="52" y="10" width="8" height="70" rx="4" fill="#1E4FCC"/><path d="M15 160 L55 160 L42 205 L28 205Z" fill="#E8E8F2"/><circle cx="35" cy="212" r="5" fill="#1E4FCC"/></svg>`,
    eraser: () => `<svg width="120" height="70" viewBox="0 0 120 70"><rect x="0" y="10" width="120" height="50" rx="10" fill="#FF7AA8"/><rect x="0" y="10" width="54" height="50" rx="10" fill="#4D8BFF"/><rect x="44" y="10" width="14" height="50" fill="#4D8BFF"/><rect x="6" y="14" width="108" height="8" rx="4" fill="#fff" opacity=".25"/></svg>`,
    clip: () => `<svg width="60" height="150" viewBox="0 0 60 150"><path d="M20 30 V115 a12 12 0 0 0 24 0 V20 a16 16 0 0 0 -32 0 V120 a20 20 0 0 0 40 0 V40" fill="none" stroke="#C9C9D6" stroke-width="6" stroke-linecap="round"/></svg>`,
  };
  const objSvg = (name) => (OBJ[name] ? OBJ[name]() : '');
  window.objSvg = objSvg;
  document.querySelectorAll('[data-obj]').forEach((el) => (el.innerHTML = objSvg(el.dataset.obj)));

  // gentle parallax: objects drift with the mouse (stronger on the login screen)
  const scene = document.getElementById('scene');
  if (!scene) return;
  let raf = 0;
  window.addEventListener('pointermove', (e) => {
    if (raf || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const k = document.body.classList.contains('in-app') ? 4 : 14;
      scene.style.setProperty('--px', (((e.clientX / innerWidth) - 0.5) * -k).toFixed(2));
      scene.style.setProperty('--py', (((e.clientY / innerHeight) - 0.5) * -k).toFixed(2));
    });
  });

})();

// ---------- install as an app (PWA) ----------
(() => {
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  let deferred = null;
  const listeners = [];
  const changed = () => listeners.forEach((f) => { try { f(); } catch {} });
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
  addEventListener('appinstalled', () => { deferred = null; changed(); });
  window.otsInstall = {
    available: () => !standalone() && (!!deferred || ios),
    onChange: (f) => { listeners.push(f); f(); },
    async prompt(showIosHelp) {
      if (deferred) {
        deferred.prompt();
        try { await deferred.userChoice; } catch {}
        deferred = null; changed();
      } else if (ios && showIosHelp) showIosHelp();
    },
    iosHelpHtml: (name) => `
      <div class="modal-head"><h2>Install ${name}</h2><button class="btn btn-ghost btn-sm" data-close>Close</button></div>
      <ol class="ios-steps">
        <li>Open this page in <strong>Safari</strong>.</li>
        <li>Tap the <strong>Share</strong> button <span class="ios-share" aria-hidden="true"></span> at the bottom of the screen.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      </ol>
      <p class="muted" style="margin:0">The app icon appears on your home screen and opens full screen.</p>`,
  };
})();
