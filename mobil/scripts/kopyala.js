// Web uygulamasının dosyalarını (deneme/ — en güncel sürüm) Capacitor'un www/ klasörüne kopyalar.
// Tek kaynak deneme/ klasörüdür; www/ her derlemede yeniden üretilir.
// sw.js bilerek yok: uygulama içinde service worker gerekmez (dosyalar zaten cihazda)
const fs = require('fs');
const path = require('path');

const kaynak = path.resolve(__dirname, '..', '..', 'deneme');
const hedef = path.resolve(__dirname, '..', 'www');
const atla = new Set(['sw.js']);

fs.rmSync(hedef, { recursive: true, force: true });
fs.mkdirSync(hedef, { recursive: true });
let n = 0;
(function kopyala(a, b) {
  for (const d of fs.readdirSync(a, { withFileTypes: true })) {
    if (d.name.startsWith('.') || atla.has(d.name)) continue;
    const s = path.join(a, d.name), t = path.join(b, d.name);
    if (d.isDirectory()) { fs.mkdirSync(t, { recursive: true }); kopyala(s, t); }
    else { fs.copyFileSync(s, t); n++; }
  }
})(kaynak, hedef);
console.log('www/ hazır:', n, 'dosya (' + kaynak + ')');
