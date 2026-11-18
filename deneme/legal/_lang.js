// ?lang=tr → Türkçe, aksi hâlde İngilizce
(function(){ var q = /[?&]lang=([a-z]+)/.exec(location.search), l = q ? q[1] : (navigator.language || 'en').slice(0, 2);
  document.body.className = l === 'tr' ? 'tr' : 'en'; document.documentElement.lang = document.body.className; })();
