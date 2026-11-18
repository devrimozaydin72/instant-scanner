'use strict';
/* ============================================================
   METİN TANIMA (OCR) — Tesseract (WebAssembly), tamamen cihazda.
   Motor ve dil dosyaları sitenin kendi ocr/ klasöründe; görüntü hiçbir yere gönderilmez.
   Her işlenmiş sayfa (procBlob) arka planda okunur: kelimeler + konumları → aranabilir PDF
   (görünmez metin katmanı), TXT, Word ve önceki taramalarda arama.
   ============================================================ */
const OCR_BY_UI = {tr:'tur', en:'eng', es:'spa', pt:'por', fr:'fra', ru:'rus', ar:'ara', zh:'chi_sim', hi:'hin'};
const ocr = {
  mode: 'auto',              // 'auto' (uygulama dili) | dil kodu | 'off'
  worker: null, wLangs: '', loading: null, failed: false,
  queue: [], busy: false, cur: null, gen: 0, timer: 0, listeners: new Set(),
  get on(){ return this.mode !== 'off' && !this.failed; },
  /* auto: telefonun dili (ör. Türkçe telefon + İngilizce arayüz → tur), uygulama dili ve İngilizce */
  langs(){
    const l = [];
    if(this.mode === 'auto'){
      for(const n of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])){
        const c = OCR_BY_UI[String(n).slice(0, 2).toLowerCase()]; if(c){ l.push(c); break; }
      }
      l.push(OCR_BY_UI[I18N.lang] || 'eng');
    } else l.push(this.mode);
    l.push('eng');
    return [...new Set(l)];
  },
  key(){ return this.langs().join('+'); },
  done(p){ return !!(p.ocr && p.ocr.ver === p.ver && p.ocr.lang === this.key()); },
  loadScript(src){
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('yüklenemedi: ' + src)); document.head.appendChild(s); });
  },
  async ensureWorker(){
    const k = this.key();
    if(this.worker && this.wLangs === k) return this.worker;
    if(this.loading) { await this.loading.catch(() => {}); if(this.worker && this.wLangs === k) return this.worker; }
    this.loading = (async () => {
      if(!window.Tesseract) await this.loadScript('ocr/tesseract.min.js');
      if(this.worker){ try{ await this.worker.terminate(); }catch(_){} this.worker = null; }
      const t0 = performance.now();
      const base = new URL('ocr/', location.href).href;
      this.worker = await Tesseract.createWorker(this.langs(), 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', gzip: true,
      });
      this.wLangs = k;
      diagLog.push(`ocr motoru hazır (${k}) ${Math.round(performance.now() - t0)}ms`);
    })();
    try{ await this.loading; } finally { this.loading = null; }
    return this.worker;
  },
  enqueue(p){
    if(!this.on || !p || this.done(p) || this.queue.includes(p.id)) return;
    this.queue.push(p.id); this.kick(0);
  },
  enqueueAll(){ for(const p of state.pages) if(p.status === 'done') this.enqueue(p); this.emit(); },
  kick(ms){ clearTimeout(this.timer); this.timer = setTimeout(() => this.pump(), ms); },
  /* canlı çekim her zaman önceliklidir: kamera açıkken (duraklatılmadıkça) metin tanıma hiç çalışmaz, motor bile
     yüklenmez — telefonda sayfa başına 5-7 sn işlemci kullanır ve denetimleri birkaç kat yavaşlatıyordu (sürüm 31).
     Kamera kapanınca / duraklatılınca, görüntü işleme kuyruğu boşaldıktan sonra başlar. */
  idleForOcr(){
    if(typeof cam !== 'undefined' && cam.active && !cam.paused) return false;
    if(typeof proc !== 'undefined' && proc.pending()) return false;
    return true;
  },
  /* kamera yeniden açıldı: süren tanıma işçiyle birlikte durdurulur, sayfa kuyruğun başına döner */
  abort(why){
    if(!this.busy) return;
    this.gen++;
    if(this.cur && !this.queue.includes(this.cur)) this.queue.unshift(this.cur);
    const w = this.worker; this.worker = null; this.wLangs = '';
    if(w) try{ w.terminate(); }catch(_){}
    this.busy = false; this.cur = null;
    diagLog.push('ocr durduruldu (' + (why || '') + ')');
    this.emit();
  },
  async pump(){
    if(this.busy || !this.on) return;
    const gen = this.gen;
    while(this.queue.length){
      if(!this.idleForOcr()){ this.kick(400); return; }
      const id = this.queue.shift();
      const p = state.pages.find(x => x.id === id);
      if(!p || p.status !== 'done' || !p.procBlob || this.done(p)) continue;
      this.busy = true; this.cur = id; this.emit();
      try{ await this.run(p, gen); }
      catch(e){
        if(gen !== this.gen) return;                               // durduruldu: yeni pump devralır
        log('metin tanıma hatası:', e && e.message);
        if(!this.worker){ this.failed = true; this.queue = []; toast(T('Metin tanıma başlatılamadı: {e}', {e: e && e.message || e}), 4000); }
      }
      if(gen !== this.gen) return;
      this.busy = false; this.cur = null; this.emit();
    }
  },
  /* iPhone uygulaması: Apple'ın cihazdaki metin tanıması (Vision) — Tesseract'tan hızlı ve isabetli */
  async runNative(p, gen){
    const AP = {tur:'tr-TR', eng:'en-US', spa:'es-ES', por:'pt-BR', fra:'fr-FR', rus:'ru-RU', ara:'ar-SA', chi_sim:'zh-Hans', hin:'hi-IN'};
    const ver = p.ver, lang = this.key(), t0 = performance.now();
    const data = await blobToBase64(p.procBlob);
    const uri = (await native.call('Filesystem', 'writeFile', {path: 'ocr-' + p.id + '.jpg', data, directory: 'CACHE'})).uri;
    const r = await native.call('NativeScanner', 'ocr', {path: uri, langs: this.langs().map(l => AP[l]).filter(Boolean)});
    if(gen !== this.gen || p.ver !== ver) return;
    p.ocr = {ver, lang, w: r.w, h: r.h, words: (r.words || []).map(w => [w[0], w[1], w[2], w[3], w[4], null]), paras: r.paras || [], conf: 90};
    diagLog.push(`ocr ${state.pages.indexOf(p) + 1}. sayfa ${Math.round(performance.now() - t0)}ms (Apple ${r.ms}ms) kelime ${p.ocr.words.length}`);
    try{ native.call('Filesystem', 'deleteFile', {path: 'ocr-' + p.id + '.jpg', directory: 'CACHE'}).catch(() => {}); }catch(_){}
    if(typeof session !== 'undefined'){ session.saved.delete(p.id); session.schedule(); }
  },
  async run(p, gen){
    if(native.has('NativeScanner') && !this.nativeFailed){
      try{ return await this.runNative(p, gen); }
      catch(e){ this.nativeFailed = true; diagLog.push('Apple metin tanıma hata → Tesseract: ' + (e && e.message)); }
    }
    const w = await this.ensureWorker();
    if(gen !== this.gen) return;
    const ver = p.ver, lang = this.key(), t0 = performance.now();
    const res = await w.recognize(p.procBlob, {}, {text: true, blocks: true});
    if(gen !== this.gen || p.ver !== ver) return;               // durduruldu / sayfa bu arada yeniden işlendi
    const d = res.data, words = [], paras = [];
    for(const bl of d.blocks || []) for(const pa of bl.paragraphs || []){
      // dantel, desen, resim kenarından okunan anlamsız harfler: güveni düşük paragraf atlanır
      if((pa.confidence || 0) < 55) continue;
      const lines = [];
      for(const li of pa.lines || []){
        lines.push((li.text || '').replace(/\s+$/, ''));
        for(const wd of li.words || []){
          const t = (wd.text || '').trim(); if(!t || wd.confidence < 40 || !/[\p{L}\p{N}]/u.test(t) || (t.length <= 3 && wd.confidence < 80)) continue;
          const b = wd.bbox, bs = wd.baseline;
          const base = bs && bs.has_baseline !== false && isFinite(bs.y0) && isFinite(bs.y1) ? (bs.y0 + bs.y1)/2 : null;
          words.push([b.x0, b.y0, b.x1, b.y1, t, base != null && base > b.y0 && base <= b.y1 + 2 ? Math.round(base) : null]);
        }
      }
      // satır sonu tirelemesi birleştirilir ("çün-" + "kü" → "çünkü")
      let txt = '';
      for(const l of lines){ if(!l) continue; if(txt.endsWith('-') && /^[a-zçğıöşüâîû]/.test(l)) txt = txt.slice(0, -1) + l; else txt += (txt ? ' ' : '') + l; }
      if(txt.trim()) paras.push(txt.trim());
    }
    // görüntü boyutu: çıktı sayfasının kendisi (yeniden ölçeklenmedi)
    const bmp = await createImageBitmap(p.procBlob); const W = bmp.width, H = bmp.height; if(bmp.close) bmp.close();
    p.ocr = {ver, lang, w: W, h: H, words, paras, conf: Math.round(d.confidence || 0)};
    diagLog.push(`ocr ${state.pages.indexOf(p) + 1}. sayfa ${Math.round(performance.now() - t0)}ms kelime ${words.length} güven ${p.ocr.conf}`);
    if(typeof session !== 'undefined'){ session.saved.delete(p.id); session.schedule(); }
  },
  /* sayfaların metni hazır olana kadar bekle (PDF/TXT/Word öncesi). onProg(hazır, toplam). Atlanabilir. */
  async waitFor(pages, onProg, skip){
    if(!this.on) return;
    for(const p of pages) this.enqueue(p);
    this.kick(0);
    for(;;){
      const ready = pages.filter(p => this.done(p) || !p.procBlob).length;
      if(onProg) onProg(ready, pages.length);
      if(ready >= pages.length || this.failed || (skip && skip())) return;
      if(!this.busy && !this.queue.length){ for(const p of pages) if(!this.done(p)) this.enqueue(p); }
      await new Promise(r => setTimeout(r, 250));
    }
  },
  progress(){
    const pages = state.pages.filter(p => p.status === 'done' && p.procBlob);
    return {done: pages.filter(p => this.done(p)).length, total: pages.length};
  },
  emit(){ for(const f of this.listeners) try{ f(); }catch(_){} },
};

/* ---------- aranabilir PDF: görünmez metin katmanı (GlyphLess yazı tipi, Identity-H, ToUnicode) ---------- */
const GLYPHLESS_TTF = 'AAEAAAAKAIAAAwAgT1MvMkT/RUAAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZC1WRvIAAACsAAAANmhoZWED6QH2AAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lqWij/wAAAdAAAABmcG9zdDIGAmcAAAI4AAAAKQABAAAAAQAA/jgzC18PPPUAAwPoAAAAAOcgAwkAAAAA5yADCQAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAPoAAAAAAH0AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAPoAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQAJAAAAAQAAAAAAAgAHAAkAAwABBAkAAQASABAAAwABBAkAAgAOACJHbHlwaExlc3NSZWd1bGFyAEcAbAB5AHAAaABMAGUAcwBzAFIAZQBnAHUAbABhAHIAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAECAmcxAAAA';
const GLYPHLESS_CID2GID = 'eNrtwgEJAAAAAqD6fzpoh2gaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgBsA/wAQ';
function ocrPdfText(o, pw, ph){
  if(!o || !o.words || !o.words.length) return '';
  const sx = pw/o.w, sy = ph/o.h;
  let s = 'BT 3 Tr\n';
  o.words.forEach(([x0, y0, x1, y1, t, base], i) => {
    const next = o.words[i+1];
    const sameLine = next && Math.abs(((next[1] + next[3])/2) - ((y0 + y1)/2)) < (y1 - y0)*0.6 && next[0] > x0;
    const chars = [...(sameLine ? t + ' ' : t)].filter(ch => ch.codePointAt(0) <= 0xFFFF);
    if(!chars.length) return;
    const fs = Math.max(1, (y1 - y0)*sy);
    const bl = base != null ? base : y1 - (y1 - y0)*0.18;
    const wPdf = ((sameLine ? Math.min(next[0], x1 + (y1 - y0)) : x1) - x0)*sx;
    const tz = Math.max(1, wPdf/(chars.length*0.5*fs)*100);
    const hex = chars.map(ch => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    s += `/FOCR ${fs.toFixed(2)} Tf ${tz.toFixed(1)} Tz 1 0 0 1 ${(x0*sx).toFixed(2)} ${(ph - bl*sy).toFixed(2)} Tm <${hex}> Tj\n`;
  });
  return s + 'ET\n';
}
const b64bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
/* PDF'e eklenecek yazı tipi nesneleri: {objs: [[no, Uint8Array|string]...], fontRef} */
function ocrFontObjects(first){
  const ttf = b64bytes(GLYPHLESS_TTF), cg = b64bytes(GLYPHLESS_CID2GID);
  const [F, D, FD, FF, CG, TU] = [0, 1, 2, 3, 4, 5].map(i => first + i);
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n' +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  return {fontRef: F, count: 6, objs: [
    [F, `<</Type /Font /Subtype /Type0 /BaseFont /GlyphLessFont /Encoding /Identity-H /DescendantFonts [${D} 0 R] /ToUnicode ${TU} 0 R>>`],
    [D, `<</Type /Font /Subtype /CIDFontType2 /BaseFont /GlyphLessFont /CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /FontDescriptor ${FD} 0 R /DW 500 /CIDToGIDMap ${CG} 0 R>>`],
    [FD, `<</Type /FontDescriptor /FontName /GlyphLessFont /Flags 5 /FontBBox [0 0 500 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 /FontFile2 ${FF} 0 R>>`],
    [FF, {dict: `<</Length ${ttf.length} /Length1 ${ttf.length}>>`, data: ttf}],
    [CG, {dict: `<</Length ${cg.length} /Filter /FlateDecode>>`, data: cg}],
    [TU, {dict: `<</Length ${cmap.length}>>`, data: new TextEncoder().encode(cmap)}],
  ]};
}

/* ---------- düz metin ve Word ---------- */
function ocrDocText(pages){
  return pages.map(p => (p.ocr && p.ocr.paras || []).join('\n\n')).filter(t => t.trim()).join('\n\n\f\n\n');
}
const CRC_T = (() => { const t = new Uint32Array(256); for(let n=0;n<256;n++){ let c = n; for(let k=0;k<8;k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for(let i=0;i<u8.length;i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
/* sıkıştırmasız ZIP (store) */
function zipStore(files){
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for(const [name, data] of files){
    const nm = enc.encode(name), d = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(d);
    const hdr = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(nm.length), ...u16(0)]);
    parts.push(hdr, nm, d);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nm);
    off += hdr.length + nm.length + d.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  return new Blob([...parts, ...central, end]);
}
function ocrDocx(pages, title){
  const x = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  let body = '';
  pages.forEach((p, i) => {
    if(i) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    for(const t of (p.ocr && p.ocr.paras) || []) body += `<w:p><w:r><w:t xml:space="preserve">${x(t)}</w:t></w:r></w:p>`;
  });
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ]);
}
