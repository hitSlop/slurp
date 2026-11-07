(function () {
  var SKIP = { axis: 1, legend: 1, title: 1, 'line mark': 1, 'area mark': 1, 'trail mark': 1 };
  var tip = document.createElement('div');
  tip.className = 'slurp-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  // The script replaces the browser's own tooltips, so remove them to show only one.
  [].forEach.call(document.querySelectorAll('svg title'), function (t) { t.remove(); });
  var current = null;
  function mark(target) {
    var el = target && target.closest ? target.closest('[role="graphics-symbol"][aria-label]') : null;
    return el && !SKIP[el.getAttribute('aria-roledescription')] ? el : null;
  }
  function fill(label) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    label.split('; ').forEach(function (part) {
      var row = document.createElement('div');
      var at = part.indexOf(': ');
      if (at > 0) {
        var key = document.createElement('span');
        key.textContent = part.slice(0, at) + ' ';
        row.appendChild(key);
        row.appendChild(document.createTextNode(part.slice(at + 2)));
      } else {
        row.textContent = part;
      }
      tip.appendChild(row);
    });
  }
  function hide() {
    tip.hidden = true;
    if (current) current.classList.remove('slurp-hover');
    current = null;
  }
  function show(e) {
    var el = mark(e.target);
    if (!el) return hide();
    if (el !== current) {
      if (current) current.classList.remove('slurp-hover');
      current = el;
      el.classList.add('slurp-hover');
      fill(el.getAttribute('aria-label'));
    }
    tip.hidden = false;
    var x = e.clientX + 14, y = e.clientY + 14;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = Math.max(8, e.clientX - tip.offsetWidth - 14);
    if (y + tip.offsetHeight > window.innerHeight - 8) y = Math.max(8, e.clientY - tip.offsetHeight - 14);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  document.addEventListener('pointermove', show);
  document.addEventListener('pointerdown', show);
  document.addEventListener('pointerleave', hide);
  window.addEventListener('scroll', hide, true);
})();
