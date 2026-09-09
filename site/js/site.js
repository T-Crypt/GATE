(function () {
  var root = document.documentElement;
  var themes = ['gate', 'signal', 'violet', 'safety'];

  // Accent cycle — persists per project so each docs site keeps its own choice.
  var saved = null;
  try { saved = localStorage.getItem('gate-accent'); } catch (e) {}
  if (themes.indexOf(saved) !== -1) root.dataset.accent = saved;

  var toggle = document.querySelector('.accent-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.dataset.accent || themes[0];
      var next = themes[(themes.indexOf(current) + 1) % themes.length];
      root.dataset.accent = next;
      try { localStorage.setItem('gate-accent', next); } catch (e) {}
    });
  }

  // Mobile menu.
  var menuBtn = document.querySelector('.menu-toggle');
  var navMain = document.querySelector('.nav-main');
  if (menuBtn && navMain) {
    menuBtn.addEventListener('click', function () {
      var open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', open);
      navMain.dataset.open = open;
    });
  }

  // Copy buttons on code blocks.
  Array.prototype.forEach.call(document.querySelectorAll('pre'), function (pre) {
    var code = pre.querySelector('code');
    if (!code || !code.innerText) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.textContent = 'copy';
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.innerText).then(function () {
        btn.textContent = 'copied';
        setTimeout(function () { btn.textContent = 'copy'; }, 1200);
      });
    });
    pre.appendChild(btn);
  });
})();