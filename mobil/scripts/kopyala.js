// Web uygulamasının dosyalarını (proje kökü) Capacitor'un www/ klasörüne kopyalar.
// Tek kaynak kök klasördeki dosyalardır; www/ her derlemede yeniden üretilir.
const fs = require('fs');
const path = require('path');

const kok = path.resolve(__dirname, '..', '..');
const hedef = path.resolve(__dirname, '..', 'www');
// sw.js bilerek yok: uygulama içinde service worker gerekmez (dosyalar zaten cihazda)
const dosyalar = ['index.html', 'core.js', 'manifest.webmanifest', 'icon.svg'];

fs.rmSync(hedef, { recursive: true, force: true });
fs.mkdirSync(hedef, { recursive: true });
for (const d of dosyalar) {
  fs.copyFileSync(path.join(kok, d), path.join(hedef, d));
}
console.log('www/ hazır:', dosyalar.join(', '));
