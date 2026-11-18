/* canlı sayfa takibi + eğitilmiş köşe modeli (modül işçisi)
   Her karede: eğitilmiş köşe modeli (scanic-ml / DocCornerNet LEAN, MIT, ~2 MB, cihazda — dışarıya veri gitmez)
   sayfanın dört köşesini tahmin eder; core.js trackFrame bu tahmini en güçlü aday olarak alır, kenar karşıtlığıyla
   doğrular ve kenarları gerçek kağıt sınırına oturtur. Model yüklenemezse takip modelsiz sürer. */
import './core.js';
const C = self.ScanCore;
let ML = null, mlErr = null, mlMs = 0, mlN = 0, told = false;
// model ve çalışma zamanı uygulamanın kendi klasöründen yüklenir (her çağrıda aynı ayar: aksi hâlde CDN'den yüklemeye kalkar)
const OPT = {assetBaseUrl: new URL('./ml/', self.location.href).href, numThreads: 1, minScore: 0};
const ready = (async () => {
  try{
    const m = await import('./ml/scanic-mlDetector.js');
    await m.initializeMl(OPT);
    ML = m.detectDocumentMl;
  }catch(e){ mlErr = String(e && e.message || e); }
})();
const KEYS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
self.onmessage = async e => {
  const m = e.data;
  try{
    if(m.kind !== 'track') return;
    await ready;
    const t0 = Date.now();
    const im = new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h);
    let extra = null, score = null;
    if(ML){
      const t1 = Date.now();
      const r = await ML(im, OPT);
      mlMs = mlMs ? mlMs*0.8 + (Date.now() - t1)*0.2 : Date.now() - t1; mlN++;
      score = r && r.score;
      if(r && r.corners && (score == null || score > 0.5)) extra = [{src: 'ml', q: KEYS.map(k => [r.corners[k].x/m.w, r.corners[k].y/m.h])}];
    }
    const c = C.mkCanvas(m.w, m.h); C.ctx2d(c).putImageData(im, 0, 0);
    const r = C.trackFrame(c, m.prev, m.anchor, extra, {fast: !!m.fast, ms: m.ms || 200});
    const out = {id: m.id, ok: true, r, fast: !!m.fast, ms: Date.now() - t0, ml: ML ? {ms: Math.round(mlMs), score} : null};
    if(!told){ told = true; out.mlInfo = ML ? 'model hazır' : 'model yüklenemedi: ' + mlErr; }
    self.postMessage(out);
  }catch(err){
    self.postMessage({id: m.id, ok: false, error: String(err && err.stack || err)});
  }
};
