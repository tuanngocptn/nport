function nportCopy(text) {
  navigator.clipboard.writeText(text).then(function() {
    var toast = document.getElementById('copy-toast');
    if (!toast) return;
    toast.classList.remove('opacity-0', '-translate-y-2');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(function() {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-2');
    }, 2000);
  });
}

function nportToggleTheme() {
  var isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('nport-theme', isDark ? 'dark' : 'light');
}

(function() {
  var learnMore = null;
  function onScroll() {
    if (!learnMore) learnMore = document.getElementById('learn-more');
    if (!learnMore) return;
    if (window.scrollY > 80) {
      learnMore.style.opacity = '0';
      learnMore.style.pointerEvents = 'none';
    } else {
      learnMore.style.opacity = '1';
      learnMore.style.pointerEvents = '';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
})();
