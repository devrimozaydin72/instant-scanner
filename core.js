/* ============================================================
   INSTANT SCANNER — çekirdek görüntü işleme
   Hem ana iş parçacığında (<script src="core.js">) hem de
   Web Worker içinde (new Worker('core.js')) çalışır.
   Harici kütüphane yok; her şey cihazda.
   ============================================================ */
(function(G){
'use strict';
const IN_WORKER = typeof document === 'undefined';

/* ---------- tuval yardımcıları ---------- */
function mkCanvas(w, h){
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if(IN_WORKER) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function ctx2d(c){ return c.getContext('2d', {willReadFrequently:true}); }
function canvasToBlob(c, type, q){
  if(typeof c.convertToBlob === 'function') return c.convertToBlob({type, quality:q});
  return new Promise(res => c.toBlob(res, type, q));
}
function imgData(c){ return ctx2d(c).getImageData(0, 0, c.width, c.height); }
function putRGBA(d, w, h){
  const c = mkCanvas(w, h), x = ctx2d(c);
  const id = x.createImageData(w, h); id.data.set(d); x.putImageData(id, 0, 0);
  return c;
}

/* ---------- temel ölçümler ---------- */
function grayOf(d, n){
  const g = new Float32Array(n);
  for(let i=0;i<n;i++){ const j=i*4; g[i] = 0.299*d[j] + 0.587*d[j+1] + 0.114*d[j+2]; }
  return g;
}
function toGray(id){ return grayOf(id.data, id.width*id.height); }
function mean(a){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]; return s/a.length; }
function lapVar(g, w, h){
  let sum=0, sum2=0, n=0;
  for(let y=1;y<h-1;y++){
    const r=y*w;
    for(let x=1;x<w-1;x++){
      const i=r+x, v = 4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w];
      sum+=v; sum2+=v*v; n++;
    }
  }
  const m=sum/n; return sum2/n - m*m;
}
function quantile(arr, q){
  const a = Float32Array.from(arr).sort();
  return a.length ? a[Math.min(a.length-1, Math.max(0, (a.length*q)|0))] : 0;
}
function boxBlur(src, w, h, r, iter){
  let a = src, b = new Float32Array(src.length);
  const k = 2*r+1;
  for(let it=0; it<iter; it++){
    for(let y=0;y<h;y++){
      const row=y*w; let s=0;
      for(let x=-r;x<=r;x++) s += a[row + Math.min(w-1, Math.max(0,x))];
      for(let x=0;x<w;x++){
        b[row+x] = s/k;
        s += a[row + Math.min(w-1, x+r+1)] - a[row + Math.max(0, x-r)];
      }
    }
    for(let x=0;x<w;x++){
      let s=0;
      for(let y=-r;y<=r;y++) s += b[Math.min(h-1, Math.max(0,y))*w + x];
      for(let y=0;y<h;y++){
        a[y*w+x] = s/k;
        s += b[Math.min(h-1, y+r+1)*w + x] - b[Math.max(0, y-r)*w + x];
      }
    }
  }
  return a;
}
/* Chrome'da tek adımda büyük küçültme örtüşme (aliasing) yapar;
   kademeli yarıya indirerek gerçek alan ortalaması elde ederiz */
function downscale(src, tw, th){
  const sw0 = src.videoWidth || src.width, sh0 = src.videoHeight || src.height;
  let cur = src, cw = sw0, ch = sh0;
  while(cw > tw*2 && ch > th*2){
    const nw = Math.max(tw, Math.ceil(cw/2)), nh = Math.max(th, Math.ceil(ch/2));
    const c = mkCanvas(nw, nh), x = ctx2d(c);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const c = mkCanvas(tw, th), x = ctx2d(c);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, tw, th);
  return c;
}

/* ---------- geometri ---------- */
function otsu(g){
  const hist = new Float64Array(256);
  for(let i=0;i<g.length;i++) hist[Math.max(0, Math.min(255, g[i]|0))]++;
  const total = g.length;
  let sum=0; for(let i=0;i<256;i++) sum += i*hist[i];
  let sumB=0, wB=0, best=0, thr=127;
  for(let i=0;i<256;i++){
    wB += hist[i]; if(!wB) continue;
    const wF = total-wB; if(!wF) break;
    sumB += i*hist[i];
    const mB = sumB/wB, mF = (sum-sumB)/wF;
    const between = wB*wF*(mB-mF)*(mB-mF);
    if(between > best){ best = between; thr = i; }
  }
  return thr;
}
/* 4 nokta çiftinden homografi: (u,v) hedef → (x,y) kaynak */
function homography(dst, src){
  const A = [], b = [];
  for(let i=0;i<4;i++){
    const [u,v] = dst[i], [x,y] = src[i];
    A.push([u,v,1,0,0,0,-u*x,-v*x]); b.push(x);
    A.push([0,0,0,u,v,1,-u*y,-v*y]); b.push(y);
  }
  const n=8;
  for(let c=0;c<n;c++){
    let p=c;
    for(let r=c+1;r<n;r++) if(Math.abs(A[r][c])>Math.abs(A[p][c])) p=r;
    if(Math.abs(A[p][c])<1e-10) return null;
    [A[c],A[p]]=[A[p],A[c]]; [b[c],b[p]]=[b[p],b[c]];
    for(let r=c+1;r<n;r++){
      const f=A[r][c]/A[c][c];
      for(let k=c;k<n;k++) A[r][k]-=f*A[c][k];
      b[r]-=f*b[c];
    }
  }
  const h=new Float64Array(n);
  for(let r=n-1;r>=0;r--){
    let s=b[r];
    for(let k=r+1;k<n;k++) s-=A[r][k]*h[k];
    h[r]=s/A[r][r];
  }
  return h;
}
function applyH(h, u, v){
  const den = h[6]*u + h[7]*v + 1;
  return [(h[0]*u + h[1]*v + h[2])/den, (h[3]*u + h[4]*v + h[5])/den];
}
function lineInter(p1,p2,p3,p4){
  const d1x=p2[0]-p1[0], d1y=p2[1]-p1[1], d2x=p4[0]-p3[0], d2y=p4[1]-p3[1];
  const den = d1x*d2y - d1y*d2x;
  if(Math.abs(den) < 1e-9) return null;
  const t = ((p3[0]-p1[0])*d2y - (p3[1]-p1[1])*d2x) / den;
  return [p1[0]+t*d1x, p1[1]+t*d1y];
}
const dist = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
function quadArea(q){
  let s=0;
  for(let i=0;i<4;i++){ const a=q[i], b=q[(i+1)%4]; s += a[0]*b[1]-b[0]*a[1]; }
  return Math.abs(s)/2;
}
function isConvex(q){
  let sign=0;
  for(let i=0;i<4;i++){
    const a=q[i], b=q[(i+1)%4], c=q[(i+2)%4];
    const cr=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    if(Math.abs(cr)<1e-6) continue;
    const s=Math.sign(cr);
    if(sign===0) sign=s; else if(s!==sign) return false;
  }
  return true;
}
function inQuad(q, x, y){
  let sign=0;
  for(let i=0;i<4;i++){
    const a=q[i], b=q[(i+1)%4];
    const cr=(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);
    const s = cr>0 ? 1 : cr<0 ? -1 : 0;
    if(!s) continue;
    if(!sign) sign=s; else if(s!==sign) return false;
  }
  return true;
}
/* Zhang & He (2007): kamera odak uzaklığı tahmini ile dörtgenin GERÇEK en/boy oranı */
function estimateAspect(q, W, H){
  const u0=W/2, v0=H/2;
  const P = p => [p[0]-u0, p[1]-v0, 1];
  const m1=P(q[0]), m2=P(q[1]), m3=P(q[3]), m4=P(q[2]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const side = ((dist(q[0],q[1])+dist(q[3],q[2]))/2) / ((dist(q[0],q[3])+dist(q[1],q[2]))/2);
  const c14 = cross(m1,m4);
  const k2 = dot(c14,m3)/dot(cross(m2,m4),m3);
  const k3 = dot(c14,m2)/dot(cross(m3,m4),m2);
  if(!isFinite(k2) || !isFinite(k3)) return side;
  const n2 = [k2*m2[0]-m1[0], k2*m2[1]-m1[1], k2*m2[2]-m1[2]];
  const n3 = [k3*m3[0]-m1[0], k3*m3[1]-m1[1], k3*m3[2]-m1[2]];
  const fdef = 0.85*Math.max(W,H);
  let f = fdef;
  const f2 = -(n2[0]*n3[0] + n2[1]*n3[1]) / (n2[2]*n3[2]);
  if(isFinite(f2) && f2 > 0){
    const ff = Math.sqrt(f2);
    if(ff > 0.45*fdef && ff < 2.2*fdef) f = ff;
  }
  const num = (n2[0]*n2[0]+n2[1]*n2[1])/(f*f) + n2[2]*n2[2];
  const den = (n3[0]*n3[0]+n3[1]*n3[1])/(f*f) + n3[2]*n3[2];
  let ar = Math.sqrt(num/den);
  if(!isFinite(ar) || ar <= 0) return side;
  return Math.max(side*0.7, Math.min(side*1.45, ar));
}

/* ---------- morfoloji & bileşenler ---------- */
function dilate1(m, w, h){
  const o = new Uint8Array(m);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x;
    if(m[i]) continue;
    if((x>0 && m[i-1]) || (x<w-1 && m[i+1]) || (y>0 && m[i-w]) || (y<h-1 && m[i+w])) o[i]=1;
  }
  return o;
}
/* aşındırma: görüntü kenarı "aynı değer" sayılır (kenara taşan sayfa
   kenardan aşınmaz → kadraj dışına taşma doğru tespit edilir) */
function erode1(m, w, h){
  const o = new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x;
    if(!m[i]) continue;
    o[i] = (x>0?m[i-1]:1) & (x<w-1?m[i+1]:1) & (y>0?m[i-w]:1) & (y<h-1?m[i+w]:1);
  }
  return o;
}
/* yalnızca dikey: yatay metin bantlarını köprüler, dikey sırt çizgisini korur */
function dilateV(m, w, h){
  const o = new Uint8Array(m);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x;
    if(m[i]) continue;
    if((y>0 && m[i-w]) || (y<h-1 && m[i+w])) o[i]=1;
  }
  return o;
}
function erodeV(m, w, h){
  const o = new Uint8Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x;
    if(!m[i]) continue;
    o[i] = (y>0?m[i-w]:1) & (y<h-1?m[i+w]:1);
  }
  return o;
}
function labelComponents(mask, w, h){
  const labels = new Int32Array(w*h), stack = new Int32Array(w*h);
  const sizes = [0]; let n=0;
  for(let s=0;s<w*h;s++){
    if(!mask[s] || labels[s]) continue;
    n++; let top=0, size=0;
    stack[top++]=s; labels[s]=n;
    while(top){
      const i=stack[--top]; size++;
      const x=i%w, y=(i/w)|0;
      if(x>0   && mask[i-1] && !labels[i-1]){ labels[i-1]=n; stack[top++]=i-1; }
      if(x<w-1 && mask[i+1] && !labels[i+1]){ labels[i+1]=n; stack[top++]=i+1; }
      if(y>0   && mask[i-w] && !labels[i-w]){ labels[i-w]=n; stack[top++]=i-w; }
      if(y<h-1 && mask[i+w] && !labels[i+w]){ labels[i+w]=n; stack[top++]=i+w; }
    }
    sizes.push(size);
  }
  return {labels, sizes, count:n};
}
/* sağlam dörtgen: uç noktalar + her kenarı piksellerin %98.5'ini
   kapsayana dek dışa kaydır (kıvrık köşe lobları dörtgeni şişiremez) */
function robustQuad(xs, ys, n, mask, mw, mh){
  let iTL=0,iTR=0,iBR=0,iBL=0;
  for(let i=1;i<n;i++){
    if(xs[i]+ys[i] < xs[iTL]+ys[iTL]) iTL=i;
    if(ys[i]-xs[i] < ys[iTR]-xs[iTR]) iTR=i;
    if(xs[i]+ys[i] > xs[iBR]+ys[iBR]) iBR=i;
    if(ys[i]-xs[i] > ys[iBL]-xs[iBL]) iBL=i;
  }
  const Q=[[xs[iTL],ys[iTL]],[xs[iTR],ys[iTR]],[xs[iBR],ys[iBR]],[xs[iBL],ys[iBL]]];
  const C=[(Q[0][0]+Q[1][0]+Q[2][0]+Q[3][0])/4,(Q[0][1]+Q[1][1]+Q[2][1]+Q[3][1])/4];
  const lines=[], proj=new Float32Array(n);
  for(let e=0;e<4;e++){
    const A=Q[e], B=Q[(e+1)%4];
    let nx=B[1]-A[1], ny=-(B[0]-A[0]);
    const len=Math.hypot(nx,ny);
    if(len<1) return null;
    nx/=len; ny/=len;
    if(nx*(A[0]-C[0])+ny*(A[1]-C[1])<0){ nx=-nx; ny=-ny; }
    let pmin=1e9, pmax=-1e9;
    for(let i=0;i<n;i++){ const v=(xs[i]-A[0])*nx+(ys[i]-A[1])*ny; proj[i]=v; if(v<pmin) pmin=v; if(v>pmax) pmax=v; }
    // %98.5 yüzdelik: sıralama yerine histogram (O(n))
    const NB=512, bw=(pmax-pmin)/NB || 1, hist=new Int32Array(NB+1);
    for(let i=0;i<n;i++) hist[Math.min(NB, ((proj[i]-pmin)/bw)|0)]++;
    const need=Math.min(n-1, (n*0.985)|0); let acc=0, bi=0;
    for(; bi<=NB; bi++){ acc+=hist[bi]; if(acc>need) break; }
    const shift=Math.max(0, pmin + (bi+1)*bw);
    lines.push([[A[0]+nx*shift,A[1]+ny*shift],[B[0]+nx*shift,B[1]+ny*shift]]);
  }
  const quad=[];
  for(let e=0;e<4;e++){
    const L1=lines[(e+3)%4], L2=lines[e];
    const X=lineInter(L1[0],L1[1],L2[0],L2[1]);
    if(!X) return null;
    quad.push(X);
  }
  return mask ? refineQuad(quad, mask, mw, mh) : quad;
}
/* köşeden köşeye kenar yönü, köşeler maskede yuvarlanınca (aşındırma, gölge) eğik çıkar →
   her kenarın orta bölümündeki sınır piksellerine sağlam doğru uydurulur, kenarlar kesiştirilir */
function refineQuad(quad, mask, w, h){
  const bx = [], by = [];
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    const i = y*w+x;
    if(mask[i] && (!mask[i-1] || !mask[i+1] || !mask[i-w] || !mask[i+w])){ bx.push(x); by.push(y); }
  }
  if(bx.length < 40) return quad;
  const tol = Math.max(3, 0.05*Math.min(w, h));
  const lines = [];
  for(let e=0;e<4;e++){
    const A = quad[e], B = quad[(e+1)%4];
    const len = Math.hypot(B[0]-A[0], B[1]-A[1]); if(len < 8){ lines.push([A, B]); continue; }
    const dx = (B[0]-A[0])/len, dy = (B[1]-A[1])/len, nx = -dy, ny = dx;
    let px = [], py = [];
    for(let k=0;k<bx.length;k++){
      const ux = bx[k]-A[0], uy = by[k]-A[1];
      const t = ux*dx + uy*dy, d = ux*nx + uy*ny;
      if(t > len*0.15 && t < len*0.85 && Math.abs(d) < tol){ px.push(bx[k]); py.push(by[k]); }
    }
    let line = [A, B];
    for(let it=0; it<3 && px.length >= 8; it++){
      // toplam en küçük kareler doğrusu
      let mx = 0, my = 0; for(let k=0;k<px.length;k++){ mx += px[k]; my += py[k]; } mx /= px.length; my /= px.length;
      let sxx = 0, syy = 0, sxy = 0; for(let k=0;k<px.length;k++){ const a = px[k]-mx, b = py[k]-my; sxx += a*a; syy += b*b; sxy += a*b; }
      const th = 0.5*Math.atan2(2*sxy, sxx - syy), ex = Math.cos(th), ey = Math.sin(th);
      // ilk kenardan en çok ~12° sapabilir
      if(Math.abs(ex*dx + ey*dy) < 0.978) break;
      line = [[mx - ex*len, my - ey*len], [mx + ex*len, my + ey*len]];
      const res = px.map((x, k) => Math.abs((x-mx)*(-ey) + (py[k]-my)*ex));
      const med = quantile(res, 0.5), lim = Math.max(1.5, med*2.5);
      const nx2 = [], ny2 = [];
      for(let k=0;k<px.length;k++) if(res[k] <= lim){ nx2.push(px[k]); ny2.push(py[k]); }
      if(nx2.length === px.length) break;
      px = nx2; py = ny2;
    }
    lines.push(line);
  }
  const out = [];
  for(let e=0;e<4;e++){
    const L1 = lines[(e+3)%4], L2 = lines[e];
    const X = lineInter(L1[0], L1[1], L2[0], L2[1]);
    if(!X || !isFinite(X[0]) || !isFinite(X[1]) || Math.hypot(X[0]-quad[e][0], X[1]-quad[e][1]) > 0.25*Math.max(w, h)) return quad;
    out.push(X);
  }
  return isConvex(out) ? out : quad;
}

/* ten rengi (ham): kırmızı kitap kapağını (g çok düşük) dışarıda bırakır */
function isSkin(r, g, b){
  return r-g > 18 && r-b > 38 && r > 60 && g > r*0.42;
}
/* kağıt rengine göre ten testi. Sarı/sıcak ışıkta krem kağıdın kendisi ham
   testten geçer → önce kağıt nötr beyaza dengelenir; ten ayrıca kağıttan
   belirgin koyu olmalıdır. pc: kağıt rengi [r,g,b] */
function skinRef(pc){
  const pm = Math.max(pc[0], pc[1], pc[2], 1);
  return {wr: pm/Math.max(pc[0],1), wg: pm/Math.max(pc[1],1), wb: pm/Math.max(pc[2],1),
          L: 0.299*pc[0]+0.587*pc[1]+0.114*pc[2]};
}
function isSkinRef(r, g, b, ref){
  const l = 0.299*r+0.587*g+0.114*b;
  if(l > ref.L*0.93) return false;                 // ten kağıttan koyudur
  const R = r*ref.wr, Gg = g*ref.wg, B = b*ref.wb; // kağıt = nötr
  if(R < 60) return false;
  // ten: kağıda göre belirgin kırmızımsı-turuncu, r > g ≥ b sıralı;
  // kırmızı kitap kapağı (g çok düşük) hariç
  return (R-Gg)/R > 0.085 && (R-B)/R > 0.14 && Gg > R*0.45 && B < Gg*1.06;
}

/* ============================================================
   SAYFA TESPİTİ (düşük çözünürlük) — canlı tarama, video ve
   tam işleme aynı fonksiyonu kullanır.
   px: küçük RGBA, (sw,sh) küçük boyut, (W,H) gerçek kare boyutu
   ============================================================ */
function detectPageData(px, sw, sh, W, H){
  const res = {ok:false, quad:null, quadS:null, comp:null, sw, sh, W, H,
               area:0, fill:0, skin:0, skinInner:0, clipped:[false,false,false,false], reason:''};
  const N = sw*sh;
  const base = new Float32Array(N), warm = new Float32Array(N);
  for(let i=0;i<N;i++){
    const r=px[i*4], g=px[i*4+1], b=px[i*4+2];
    base[i] = Math.min(r, g, b);
    warm[i] = r - b;
  }
  // 1) Otsu ile parlak (kağıt) maskesi
  const thrB = otsu(base) * 0.92;
  let mask = new Uint8Array(N), nb=0;
  for(let i=0;i<N;i++) if(base[i] > thrB){ mask[i]=1; nb++; }
  if(nb < N*0.08){ res.reason='karanlık'; return res; }
  // 1b) dokulu ama YÖNSÜZ bölgeler (dantel, desenli örtü, klavye) kağıt değildir.
  //     Yazı da dokuludur ama yönlüdür (yatay satırlar) → yapı tensörü anizotropisi
  {
    const gx = new Float32Array(N), gy = new Float32Array(N);
    for(let y=1;y<sh-1;y++) for(let x=1;x<sw-1;x++){
      const i=y*sw+x; gx[i]=(base[i+1]-base[i-1])*0.5; gy[i]=(base[i+sw]-base[i-sw])*0.5;
    }
    const Jxx = new Float32Array(N), Jyy = new Float32Array(N), Jxy = new Float32Array(N);
    for(let i=0;i<N;i++){ Jxx[i]=gx[i]*gx[i]; Jyy[i]=gy[i]*gy[i]; Jxy[i]=gx[i]*gy[i]; }
    boxBlur(Jxx, sw, sh, 2, 1); boxBlur(Jyy, sw, sh, 2, 1); boxBlur(Jxy, sw, sh, 2, 1);
    const iso = new Float32Array(N);
    for(let i=0;i<N;i++){
      const tr = Jxx[i]+Jyy[i];
      if(tr < 49) continue;                                 // düz (kağıt/kenar boşluğu)
      const an = Math.sqrt((Jxx[i]-Jyy[i])*(Jxx[i]-Jyy[i]) + 4*Jxy[i]*Jxy[i]) / tr;
      if(an < 0.5) iso[i] = 1;
    }
    boxBlur(iso, sw, sh, 2, 1);                             // 5×5 çoğunluk
    // Yönsüz doku (dantel, desenli örtü) maskeden silinir. Küçük ölçekte sayfa içindeki yazı da
    // yönsüz görünüp delinebilir; o delikler sayfa seçildikten sonra (açmadan önce) doldurulur.
    let removed = 0;
    for(let i=0;i<N;i++) if(mask[i] && iso[i] > 0.45){ mask[i] = 0; removed++; }
    res.texRemoved = removed / N;
  }
  // 2) sıcaklık kümelemesi: kağıt sıcak, ekran/soğuk ışık mavimsi
  {
    let c0=1e9, c1=-1e9;
    for(let i=0;i<N;i++) if(mask[i]){ if(warm[i]<c0) c0=warm[i]; if(warm[i]>c1) c1=warm[i]; }
    for(let k=0;k<12;k++){
      let s0=0,n0=0,s1=0,n1=0;
      for(let i=0;i<N;i++) if(mask[i]){
        const v=warm[i];
        if(Math.abs(v-c0)<=Math.abs(v-c1)){ s0+=v; n0++; } else { s1+=v; n1++; }
      }
      if(n0) c0=s0/n0; if(n1) c1=s1/n1;
    }
    if(c1-c0 > 18){
      const mid=(c0+c1)/2;
      // soğuk küme karenin ortasını kaplıyorsa sayfanın kendisidir (gün ışığı /
      // karışık ışık) → ayırma yapma; ekran hep arka planda, kenardadır
      let cm=0, cc=0;
      for(let y=(sh*0.3)|0; y<(sh*0.7)|0; y++) for(let x=(sw*0.3)|0; x<(sw*0.7)|0; x++){
        const i=y*sw+x; if(mask[i]){ cm++; if(warm[i] <= mid) cc++; }
      }
      if(!cm || cc/cm < 0.25)
        for(let i=0;i<N;i++) if(mask[i] && warm[i] <= mid) mask[i]=0;
    }
  }
  // 3) DİKEY kapama: metin bantlarını köprüler, sırt çizgisini korur
  for(let k=0;k<5;k++) mask = dilateV(mask, sw, sh);
  for(let k=0;k<5;k++) mask = erodeV(mask, sw, sh);
  mask = erode1(mask, sw, sh);
  for(let x=0;x<sw;x++){ mask[x]=0; mask[(sh-1)*sw+x]=0; }
  for(let y=0;y<sh;y++){ mask[y*sw]=0; mask[y*sw+sw-1]=0; }
  // 4) bileşenler; merkezdeki bileşeni tercih et
  const L = labelComponents(mask, sw, sh);
  if(!L.count){ res.reason='sayfa yok'; return res; }
  const counts = new Float64Array(L.count+1);
  const wx0=(sw*0.38)|0, wx1=(sw*0.62)|0, wy0=(sh*0.38)|0, wy1=(sh*0.62)|0;
  for(let y=wy0;y<wy1;y++) for(let x=wx0;x<wx1;x++){ const l=L.labels[y*sw+x]; if(l) counts[l]++; }
  let best=0;
  for(let l=1;l<=L.count;l++) if(counts[l]>counts[best]) best=l;
  if(!best || !counts[best]) for(let l=1;l<=L.count;l++) if(L.sizes[l]>L.sizes[best]) best=l;
  if(L.sizes[best] < N*0.12){ res.reason='sayfa küçük'; return res; }
  // 5) açma: ince kolları/yansımaları sil
  let comp = new Uint8Array(N);
  for(let i=0;i<N;i++) comp[i] = L.labels[i]===best ? 1 : 0;
  // iç delikler (doku filtresinin yazıda açtığı delikler, fotoğraflar) açmadan önce doldurulur:
  // yoksa delik deşik sayfa açmada parçalanır, kenar boşluğu ince kalır, dörtgen yamulur
  {
    const inv = new Uint8Array(N);
    for(let i=0;i<N;i++) inv[i] = comp[i] ? 0 : 1;
    const LI0 = labelComponents(inv, sw, sh);
    const bd0 = new Uint8Array(LI0.count+1);
    for(let x=0;x<sw;x++){ bd0[LI0.labels[x]]=1; bd0[LI0.labels[(sh-1)*sw+x]]=1; }
    for(let y=0;y<sh;y++){ bd0[LI0.labels[y*sw]]=1; bd0[LI0.labels[y*sw+sw-1]]=1; }
    for(let i=0;i<N;i++){ const l=LI0.labels[i]; if(l && !bd0[l]) comp[i]=1; }
  }
  const compPre = new Uint8Array(comp);   // açma öncesi (ince kenar boşlukları korunur)
  {
    let core = comp;
    for(let k=0;k<8;k++) core = erode1(core, sw, sh);
    let has=false; for(let i=0;i<N;i++) if(core[i]){ has=true; break; }
    if(has){
      const L2 = labelComponents(core, sw, sh);
      let bl=0; for(let l=1;l<=L2.count;l++) if(L2.sizes[l]>L2.sizes[bl]) bl=l;
      let big = new Uint8Array(N);
      for(let i=0;i<N;i++) big[i] = L2.labels[i]===bl ? 1 : 0;
      for(let k=0;k<8;k++) big = dilate1(big, sw, sh);
      for(let i=0;i<N;i++) comp[i] &= big[i];
    }
  }
  // delikleri doldur (sayfa içindeki fotoğraflar/koyu kutular maskeye dahil)
  let filled;
  {
    const inv = new Uint8Array(N);
    for(let i=0;i<N;i++) inv[i] = compPre[i] ? 0 : 1;
    const LI = labelComponents(inv, sw, sh);
    const border = new Uint8Array(LI.count+1);
    for(let x=0;x<sw;x++){ border[LI.labels[x]]=1; border[LI.labels[(sh-1)*sw+x]]=1; }
    for(let y=0;y<sh;y++){ border[LI.labels[y*sw]]=1; border[LI.labels[y*sw+sw-1]]=1; }
    filled = new Uint8Array(comp);
    for(let i=0;i<N;i++){ const l=LI.labels[i]; if(l && !border[l]) filled[i]=1; }
  }
  let np=0; for(let i=0;i<N;i++) if(filled[i]) np++;
  if(np < 50){ res.reason='sayfa yok'; return res; }
  const xs = new Float32Array(np), ys = new Float32Array(np);
  { let k=0; for(let y=0;y<sh;y++) for(let x=0;x<sw;x++) if(filled[y*sw+x]){ xs[k]=x; ys[k]=y; k++; } }
  const q4 = robustQuad(xs, ys, np, filled, sw, sh);
  if(!q4){ res.reason='dörtgen yok'; return res; }
  const sc = sw / W;
  const cx=(q4[0][0]+q4[1][0]+q4[2][0]+q4[3][0])/4, cy=(q4[0][1]+q4[1][1]+q4[2][1]+q4[3][1])/4;
  const quad = q4.map(([x,y]) => [
    Math.max(0, Math.min(W-1, (x + (x-cx)*0.015 + 0.5)/sc)),
    Math.max(0, Math.min(H-1, (y + (y-cy)*0.015 + 0.5)/sc)),
  ]);
  const quadS = quad.map(([x,y]) => [x*sc, y*sc]);
  res.quad = quad; res.quadS = quadS; res.comp = comp; res.compFilled = filled; res.sc = sc;
  // ölçümler
  const area = quadArea(quad);
  res.area = area/(W*H);
  res.fill = np / Math.max(1, quadArea(quadS));
  // kadraj dışına taşan kenarlar: kenar orta noktası kareye çok yakınsa
  // veya bileşen o kare kenarına geniş ölçüde değiyorsa
  const tol = 0.03*Math.min(W,H);
  const touch = [0,0,0,0];   // kare kenarları: üst, sağ, alt, sol
  for(let x=1;x<sw-1;x++){ if(filled[sw+x]) touch[0]++; if(filled[(sh-2)*sw+x]) touch[2]++; }
  for(let y=1;y<sh-1;y++){ if(filled[y*sw+1]) touch[3]++; if(filled[y*sw+sw-2]) touch[1]++; }
  const tf = [touch[0]/sw, touch[1]/sh, touch[2]/sw, touch[3]/sh];
  for(let e=0;e<4;e++){
    const a=quad[e], b=quad[(e+1)%4], m=[(a[0]+b[0])/2, (a[1]+b[1])/2];
    const dB = [m[1], W-1-m[0], H-1-m[1], m[0]];   // üst, sağ, alt, sol
    let k=0; for(let j=1;j<4;j++) if(dB[j]<dB[k]) k=j;
    if(dB[k] < tol || tf[k] > 0.15) res.clipped[e] = true;
  }
  // ten (parmak/el): dörtgen içinde, iç bölgede ayrıca — kağıt rengine göre
  {
    const rs=[], gs=[], bs=[];
    for(let i=0;i<N;i+=2) if(comp[i]){ rs.push(px[i*4]); gs.push(px[i*4+1]); bs.push(px[i*4+2]); }
    const ref = skinRef(rs.length ? [quantile(rs,0.6), quantile(gs,0.6), quantile(bs,0.6)] : [235,235,235]);
    res.paper = ref;
    let inQ=0, sk=0, inI=0, skI=0;
    const qi = quadS.map(([x,y]) => [cx + (x-cx)*0.78, cy + (y-cy)*0.78]);
    const x0=Math.max(0,Math.floor(Math.min(...quadS.map(p=>p[0])))), x1=Math.min(sw-1,Math.ceil(Math.max(...quadS.map(p=>p[0]))));
    const y0=Math.max(0,Math.floor(Math.min(...quadS.map(p=>p[1])))), y1=Math.min(sh-1,Math.ceil(Math.max(...quadS.map(p=>p[1]))));
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
      if(!inQuad(quadS, x+0.5, y+0.5)) continue;
      const i=(y*sw+x)*4, s = isSkinRef(px[i],px[i+1],px[i+2],ref) ? 1 : 0;
      inQ++; sk+=s;
      if(inQuad(qi, x+0.5, y+0.5)){ inI++; skI+=s; }
    }
    res.skin = inQ ? sk/inQ : 0;
    res.skinInner = inI ? skI/inI : 0;
  }
  // güvenlik kontrolleri
  const [TL,TR,BR,BL] = quad;
  const tw = (dist(TL,TR)+dist(BL,BR))/2, th = (dist(TL,BL)+dist(TR,BR))/2;
  const ar = tw/th;
  if(!isConvex(quad)) { res.reason='dörtgen bozuk'; return res; }
  if(tw < W*0.25 || th < H*0.25 || ar<0.28 || ar>3.6 || area < W*H*0.15 || area > W*H*1.02){
    res.reason='oran dışı'; return res;
  }
  res.ok = true;
  return res;
}
function detectPage(canvas, maxSide){
  const W = canvas.width, H = canvas.height;
  const sc = (maxSide||240)/Math.max(W,H);
  const sw = Math.max(24, Math.round(W*sc)), sh = Math.max(24, Math.round(H*sc));
  const small = downscale(canvas, sw, sh);
  const px = ctx2d(small).getImageData(0,0,sw,sh).data;
  const r = detectPageData(px, sw, sh, W, H);
  r.px = px;
  return r;
}

/* ---------- sayfa imzası (tekrar tespiti) ----------
   Sayfa bulunduysa dörtgen içi düzleştirilip imzalanır → kamera
   kayması / yakınlaşma imzayı bozmaz. */
const SIG_W = 36, SIG_H = 48;
function pageSignature(px, sw, sh, quadS){
  const out = new Float32Array(SIG_W*SIG_H);
  let q = quadS;
  if(!q) q = [[0,0],[sw-1,0],[sw-1,sh-1],[0,sh-1]];
  const hm = homography([[0,0],[SIG_W-1,0],[SIG_W-1,SIG_H-1],[0,SIG_H-1]], q);
  if(!hm) return null;
  for(let v=0; v<SIG_H; v++) for(let u=0; u<SIG_W; u++){
    let [x,y] = applyH(hm, u, v);
    x = Math.max(0, Math.min(sw-1.001, x)); y = Math.max(0, Math.min(sh-1.001, y));
    const x0=x|0, y0=y|0, fx=x-x0, fy=y-y0;
    const g = (i) => 0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
    const i00=(y0*sw+x0)*4, i10=i00+4, i01=i00+sw*4, i11=i01+4;
    out[v*SIG_W+u] = g(i00)*(1-fx)*(1-fy)+g(i10)*fx*(1-fy)+g(i01)*(1-fx)*fy+g(i11)*fx*fy;
  }
  // aydınlatma farkına dayanıklı: ortalamayı çıkar, std'ye böl
  const m = mean(out); let s=0;
  for(let i=0;i<out.length;i++){ out[i]-=m; s+=out[i]*out[i]; }
  const sd = Math.sqrt(s/out.length) || 1;
  for(let i=0;i<out.length;i++) out[i] = out[i]/sd*32;
  return out;
}
/* ±R hücre kaydırarak en iyi hizadaki ortalama mutlak fark */
function sigDiff(a, b, R){
  if(!a || !b) return 99;
  const w=SIG_W, h=SIG_H; let best=1e9;
  R = R==null ? 2 : R;
  for(let dy=-R; dy<=R; dy++) for(let dx=-R; dx<=R; dx++){
    let s=0, cnt=0;
    const y0=Math.max(0,dy), y1=h+Math.min(0,dy), x0=Math.max(0,dx), x1=w+Math.min(0,dx);
    for(let y=y0;y<y1;y++){
      const ra=y*w, rb=(y-dy)*w;
      for(let x=x0;x<x1;x++){ s += Math.abs(a[ra+x]-b[rb+x-dx]); cnt++; }
    }
    const d=s/cnt; if(d<best) best=d;
  }
  return best;
}

/* ============================================================
   YENİDEN ÖRNEKLEME (tek geçiş): çıktı pikseli → kaynak koordinatı
   eşlemesi kaba bir ızgarada hesaplanır, aradaki pikseller ızgaradan
   çift doğrusal enterpole edilir; örnekleme bikübik (Catmull-Rom).
   ============================================================ */
function buildGrid(outW, outH, gs, fn){
  const gw = Math.floor((outW-1)/gs)+2, gh = Math.floor((outH-1)/gs)+2;
  const mx = new Float32Array(gw*gh), my = new Float32Array(gw*gh);
  for(let gy=0; gy<gh; gy++) for(let gx=0; gx<gw; gx++){
    const p = fn(gx*gs, gy*gs);
    mx[gy*gw+gx] = p[0]; my[gy*gw+gx] = p[1];
  }
  return {gw, gh, gs, mx, my};
}
function remap(src, W, H, outW, outH, grid, cubic, fill){
  const d = new Uint8ClampedArray(outW*outH*4);
  const {gw, gs, mx, my} = grid;
  const W1 = W-1, H1 = H-1, rs = W*4;
  for(let v=0; v<outH; v++){
    const gyf = v/gs, gy = gyf|0, fy = gyf-gy;
    for(let u=0; u<outW; u++){
      const gxf = u/gs, gx = gxf|0, fx = gxf-gx;
      const i00 = gy*gw+gx, i01 = i00+gw;
      const a0=(1-fx)*(1-fy), a1=fx*(1-fy), a2=(1-fx)*fy, a3=fx*fy;
      let x = mx[i00]*a0 + mx[i00+1]*a1 + mx[i01]*a2 + mx[i01+1]*a3;
      let y = my[i00]*a0 + my[i00+1]*a1 + my[i01]*a2 + my[i01+1]*a3;
      const o = (v*outW+u)*4;
      if(fill && (x < -1 || y < -1 || x > W || y > H)){
        d[o]=fill[0]; d[o+1]=fill[1]; d[o+2]=fill[2]; d[o+3]=255; continue;
      }
      if(x < 0) x = 0; else if(x > W1) x = W1;
      if(y < 0) y = 0; else if(y > H1) y = H1;
      if(cubic){
        const x0=Math.floor(x), y0=Math.floor(y), tx=x-x0, ty=y-y0;
        const wx0=((-0.5*tx+1)*tx-0.5)*tx, wx1=((1.5*tx-2.5)*tx)*tx+1, wx2=((-1.5*tx+2)*tx+0.5)*tx, wx3=((0.5*tx-0.5)*tx)*tx;
        const wy0=((-0.5*ty+1)*ty-0.5)*ty, wy1=((1.5*ty-2.5)*ty)*ty+1, wy2=((-1.5*ty+2)*ty+0.5)*ty, wy3=((0.5*ty-0.5)*ty)*ty;
        const c0=(x0>0?x0-1:0)*4, c1=x0*4, c2=(x0<W1?x0+1:W1)*4, c3=(x0+2<=W1?x0+2:W1)*4;
        const r0=(y0>0?y0-1:0)*rs, r1=y0*rs, r2=(y0<H1?y0+1:H1)*rs, r3=(y0+2<=H1?y0+2:H1)*rs;
        for(let ch=0; ch<3; ch++){
          const s0 = src[r0+c0+ch]*wx0 + src[r0+c1+ch]*wx1 + src[r0+c2+ch]*wx2 + src[r0+c3+ch]*wx3;
          const s1 = src[r1+c0+ch]*wx0 + src[r1+c1+ch]*wx1 + src[r1+c2+ch]*wx2 + src[r1+c3+ch]*wx3;
          const s2 = src[r2+c0+ch]*wx0 + src[r2+c1+ch]*wx1 + src[r2+c2+ch]*wx2 + src[r2+c3+ch]*wx3;
          const s3 = src[r3+c0+ch]*wx0 + src[r3+c1+ch]*wx1 + src[r3+c2+ch]*wx2 + src[r3+c3+ch]*wx3;
          d[o+ch] = s0*wy0 + s1*wy1 + s2*wy2 + s3*wy3;
        }
      } else {
        const x0=x|0, y0=y|0, tx=x-x0, ty=y-y0;
        const x1=x0<W1?x0+1:W1, y1=y0<H1?y0+1:H1;
        const p00=y0*rs+x0*4, p10=y0*rs+x1*4, p01=y1*rs+x0*4, p11=y1*rs+x1*4;
        for(let ch=0; ch<3; ch++){
          d[o+ch] = (src[p00+ch]*(1-tx)+src[p10+ch]*tx)*(1-ty) + (src[p01+ch]*(1-tx)+src[p11+ch]*tx)*ty;
        }
      }
      d[o+3] = 255;
    }
  }
  return d;
}
function remapGray(g, w, h, fn){
  // tek kanallı, çift doğrusal; fn(x,y) → [sx, sy]
  const o = new Float32Array(w*h);
  const grid = buildGrid(w, h, 8, fn);
  const {gw, gs, mx, my} = grid;
  for(let v=0; v<h; v++){
    const gyf=v/gs, gy=gyf|0, fy=gyf-gy;
    for(let u=0; u<w; u++){
      const gxf=u/gs, gx=gxf|0, fx=gxf-gx;
      const i00=gy*gw+gx, i01=i00+gw;
      const a0=(1-fx)*(1-fy), a1=fx*(1-fy), a2=(1-fx)*fy, a3=fx*fy;
      let x = mx[i00]*a0 + mx[i00+1]*a1 + mx[i01]*a2 + mx[i01+1]*a3;
      let y = my[i00]*a0 + my[i00+1]*a1 + my[i01]*a2 + my[i01+1]*a3;
      x = Math.max(0, Math.min(w-1.001, x)); y = Math.max(0, Math.min(h-1.001, y));
      const x0=x|0, y0=y|0, tx=x-x0, ty=y-y0, p=y0*w+x0;
      o[v*w+u] = (g[p]*(1-tx)+g[p+1]*tx)*(1-ty) + (g[p+w]*(1-tx)+g[p+w+1]*tx)*ty;
    }
  }
  return o;
}

/* ============================================================
   KIVRIK SAYFA DÜZELTME — yazı satırlarından
   Sayfa dikey şeritlere bölünür; komşu şeritlerin yatay izdüşüm
   profilleri pencereler hâlinde ilişkilendirilerek satırların yerel
   düşey kayması ölçülür. Ölçümler düzgünleştirilmiş bir yer değiştirme
   alanına (şerit × yükseklik düğümleri) en küçük kareler ile oturtulur.
   Sonuç: çıktı(x,y) = giriş(x, y + D(x,y)) → satırlar dümdüz olur.
   ============================================================ */
function bgMapGray(g, w, h){
  // kağıt (arka plan) parlaklığı: blok maksimumu → genişlet → bulanıklaştır
  const bs = Math.max(6, Math.round(Math.max(w,h)/60));
  const bw = Math.ceil(w/bs), bh = Math.ceil(h/bs);
  let B = new Float32Array(bw*bh);
  for(let by=0; by<bh; by++) for(let bx=0; bx<bw; bx++){
    let m=0;
    const y1=Math.min(h,(by+1)*bs), x1=Math.min(w,(bx+1)*bs);
    for(let y=by*bs; y<y1; y+=2) for(let x=bx*bs; x<x1; x+=2){ const v=g[y*w+x]; if(v>m) m=v; }
    B[by*bw+bx]=m;
  }
  const B2 = new Float32Array(B);
  for(let by=0; by<bh; by++) for(let bx=0; bx<bw; bx++){
    let m=0;
    for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
      const yy=by+dy, xx=bx+dx;
      if(yy>=0&&yy<bh&&xx>=0&&xx<bw){ const v=B[yy*bw+xx]; if(v>m) m=v; }
    }
    B2[by*bw+bx]=m;
  }
  B = boxBlur(B2, bw, bh, 1, 2);
  const out = new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const fy = Math.max(0, Math.min(bh-1.001, (y+0.5)/bs-0.5)), y0=fy|0, ty=fy-y0;
    for(let x=0;x<w;x++){
      const fx = Math.max(0, Math.min(bw-1.001, (x+0.5)/bs-0.5)), x0=fx|0, tx=fx-x0;
      const p=y0*bw+x0;
      out[y*w+x] = (B[p]*(1-tx)+B[p+1]*tx)*(1-ty) + (B[p+bw]*(1-tx)+B[p+bw+1]*tx)*ty;
    }
  }
  return out;
}
function inkOf(g, w, h){
  const bg = bgMapGray(g, w, h);
  const medBg = quantile(bg.filter((_,i)=>i%7===0), 0.6);
  const ink = new Float32Array(w*h);
  for(let i=0;i<w*h;i++){
    const b = bg[i];
    if(b < medBg*0.4) continue;           // sayfa dışı koyu zemin (sırt gölgesindeki yazı ~0.5-0.6'da kalır, sayılır)
    const v = (b - g[i]) / b;
    if(v > 0.10) ink[i] = Math.min(1, (v-0.10)*2.5);
  }
  return ink;
}
function smooth1(a, r){
  const n=a.length, o=new Float32Array(n), k=2*r+1;
  let s=0;
  for(let i=-r;i<=r;i++) s += a[Math.max(0,Math.min(n-1,i))];
  for(let i=0;i<n;i++){ o[i]=s/k; s += a[Math.min(n-1,i+r+1)] - a[Math.max(0,i-r)]; }
  return o;
}
/* satır aralığı: şerit profilleri geniş yapılardan (fotoğraf, kenar boşluğu)
   arındırılır; her periyot için güç spektrumu hesaplanıp şeritler üzerinden
   toplanır → en güçlü periyot = satır aralığı (özilişkideki geniş düşüşten
   ve eğik satırlardan etkilenmez) */
function estimatePitch(profiles){
  const n=profiles[0].length;
  const R = Math.min(50, Math.max(8, (n/10)|0));
  const ds = [];
  for(const S of profiles){
    const m0 = mean(S);
    if(m0 > 0.28 || m0 < 0.004) continue;          // fotoğraf ya da boş şerit
    const tr = smooth1(S, R);
    const loc = smooth1(S, 12);                      // yerel mürekkep yoğunluğu
    const d=new Float32Array(n); let e=0;
    for(let i=0;i<n;i++){
      if(loc[i] > 0.26) continue;                    // fotoğraf satırları → 0
      d[i]=S[i]-tr[i]; e+=d[i]*d[i];
    }
    if(e<=1e-6) continue;
    const k = 1/Math.sqrt(e);
    for(let i=0;i<n;i++) d[i]*=k;
    ds.push(d);
  }
  if(!ds.length) return 0;
  const Lmax = Math.min(120, n/5);
  const cands = [];
  for(let L=6; L<=Lmax; L*=1.02) cands.push(L);
  const pw = new Float32Array(cands.length);
  for(let ci=0; ci<cands.length; ci++){
    const w = 2*Math.PI/cands[ci], cw = Math.cos(w), sw = Math.sin(w);
    let tot = 0;
    for(const d of ds){
      let c=1, s=0, rc=0, rs=0;
      for(let i=0;i<n;i++){
        rc += d[i]*c; rs += d[i]*s;
        const c2 = c*cw - s*sw; s = s*cw + c*sw; c = c2;
      }
      tot += rc*rc + rs*rs;
    }
    pw[ci] = tot/ds.length;
  }
  let bi=0; for(let i=1;i<pw.length;i++) if(pw[i]>pw[bi]) bi=i;
  // yerel tepe olmalı ve ortalamadan belirgin yüksek
  const avg = mean(pw);
  if(pw[bi] < avg*2.2) return 0;
  // parabolik ince ayar (logaritmik ızgara)
  let L = cands[bi];
  if(bi>0 && bi<pw.length-1){
    const den = pw[bi-1]-2*pw[bi]+pw[bi+1];
    if(den<0) L = cands[bi] * Math.pow(1.02, 0.5*(pw[bi-1]-pw[bi+1])/den);
  }
  return L;
}
function solveSPD(A, b, n){
  // Cholesky (A simetrik pozitif tanımlı)
  const L = new Float64Array(n*n);
  for(let i=0;i<n;i++){
    for(let j=0;j<=i;j++){
      let s = A[i*n+j];
      for(let k=0;k<j;k++) s -= L[i*n+k]*L[j*n+k];
      if(i===j){ if(s<=1e-12) return null; L[i*n+i]=Math.sqrt(s); }
      else L[i*n+j] = s/L[j*n+j];
    }
  }
  const y = new Float64Array(n);
  for(let i=0;i<n;i++){ let s=b[i]; for(let k=0;k<i;k++) s-=L[i*n+k]*y[k]; y[i]=s/L[i*n+i]; }
  const x = new Float64Array(n);
  for(let i=n-1;i>=0;i--){ let s=y[i]; for(let k=i+1;k<n;k++) s-=L[k*n+i]*x[k]; x[i]=s/L[i*n+i]; }
  return x;
}
/* g: gri (w×h). Dönen alan: {ns, ny, D(Float32 ns*ny, piksel), w, h, pitch, nMeas} */
/* satır aralığı için dar (≈14 px) şerit profilleri */
function narrowProfiles(ink, w, h, x0, x1){
  const nw = Math.max(10, Math.min(16, Math.round(w/40)));
  const out = [];
  for(let a=x0; a+nw<=x1; a+=nw){
    const p=new Float32Array(h);
    for(let y=0;y<h;y++){ let s=0; const r=y*w+a; for(let x=0;x<nw;x++) s+=ink[r+x]; p[y]=s/nw; }
    out.push(smooth1(p, 1));
  }
  return out;
}
function estimateTextField(ink, w, h){
  const ns = Math.max(8, Math.min(40, Math.round(w/26)));
  const sw = w/ns;
  const P = [];
  for(let k=0;k<ns;k++){
    const x0=Math.round(k*sw), x1=Math.round((k+1)*sw), cw=x1-x0;
    const p=new Float32Array(h);
    for(let y=0;y<h;y++){ let s=0; const r=y*w; for(let x=x0;x<x1;x++) s+=ink[r+x]; p[y]=s/cw; }
    P.push(smooth1(p, 1));
  }
  // satır aralığı: orta bölgenin dar şeritlerinden
  const kc = ns>>1;
  let pitch = estimatePitch(narrowProfiles(ink, w, h, Math.round(w*0.2), Math.round(w*0.8)));
  if(!pitch || pitch < 5 || pitch > h/5){ G.__fieldWhy = 'pitch:'+(pitch||0).toFixed(1); return null; }
  const hw = Math.max(6, Math.round(pitch*1.6));
  // arama aralığı: yarım satır aralığını aşmasın (bir satır kaymasın) ve
  // ~20°'den dik eğime izin verme
  const smax = Math.max(2, Math.min(Math.round(pitch*0.38), Math.round(sw*0.36)+1));
  const step = Math.max(4, Math.round(pitch*0.9));
  const wins = [];
  for(let yc=hw+smax; yc<h-hw-smax; yc+=step) wins.push(yc);
  if(wins.length < 3) return null;
  // pencere enerjileri (metin var mı?)
  const energy = (p, yc) => {
    let s=0, s2=0, n=0;
    for(let y=yc-hw;y<=yc+hw;y++){ s+=p[y]; s2+=p[y]*p[y]; n++; }
    const m=s/n; return s2/n - m*m;
  };
  const E = P.map(p => wins.map(yc => energy(p, yc)));
  const allE = []; E.forEach(r => r.forEach(v => { if(v>0) allE.push(v); }));
  if(!allE.length) return null;
  const eRef = quantile(allE, 0.75);
  const meas = [];
  const ncc = (a, b, yc, s) => {
    let sa=0, sb=0, n=0;
    for(let y=yc-hw;y<=yc+hw;y++){ sa+=a[y]; sb+=b[y+s]; n++; }
    const ma=sa/n, mb=sb/n;
    let num=0, ea=0, eb=0;
    for(let y=yc-hw;y<=yc+hw;y++){
      const da=a[y]-ma, db=b[y+s]-mb;
      num+=da*db; ea+=da*da; eb+=db*db;
    }
    return ea>0 && eb>0 ? num/Math.sqrt(ea*eb) : 0;
  };
  // merkezden dışa doğru izleme: beklenen kayma bir önceki çiftten gelir
  const track = (pairs) => {
    const exp = new Float32Array(wins.length);
    for(const k of pairs){             // çift: (k, k+1)
      const a=P[k], b=P[k+1];
      for(let wi=0; wi<wins.length; wi++){
        const yc = wins[wi];
        if(E[k][wi] < eRef*0.12 || E[k+1][wi] < eRef*0.12) continue;
        const e0 = Math.round(exp[wi]);
        let bs=0, bv=-2, vals={};
        for(let s=e0-smax; s<=e0+smax; s++){
          if(yc-hw+s<0 || yc+hw+s>=h) continue;
          const v = ncc(a, b, yc, s); vals[s]=v;
          if(v>bv){ bv=v; bs=s; }
        }
        if(bv < 0.45 || Math.abs(bs-e0) >= smax) continue;
        let sub = bs;
        if(vals[bs-1]!==undefined && vals[bs+1]!==undefined){
          const den = vals[bs-1]-2*bv+vals[bs+1];
          if(den<0) sub = bs + 0.5*(vals[bs-1]-vals[bs+1])/den;
        }
        const wgt = (bv-0.35)/0.65 * Math.min(1, Math.sqrt(Math.min(E[k][wi],E[k+1][wi])/eRef));
        meas.push({k, yc, s:sub, w:wgt});
        exp[wi] = sub;
      }
      // komşu pencerelerden boşlukları doldur (izleme kopmasın)
      for(let wi=0; wi<wins.length; wi++) if(exp[wi]===0){
        let s=0,c=0;
        for(const d of [-2,-1,1,2]){ const j=wi+d; if(j>=0&&j<wins.length&&exp[j]!==0){ s+=exp[j]; c++; } }
        if(c) exp[wi]=s/c;
      }
    }
  };
  const right=[]; for(let k=kc; k<ns-1; k++) right.push(k);
  const left=[];  for(let k=kc-1; k>=0; k--) left.push(k);
  track(right); track(left);
  if(meas.length < Math.max(8, ns)){ G.__fieldWhy = 'meas:'+meas.length; return null; }
  // en küçük kareler: bilinmeyenler D[k][j] (şerit merkezi × y düğümü)
  const ny = Math.max(3, Math.min(10, Math.round(h/(pitch*5))+1));
  const N = ns*ny;
  const hat = y => { const t=Math.max(0,Math.min(ny-1-1e-6, y/(h-1)*(ny-1))); const j=t|0; return [j, 1-(t-j), t-j]; };
  const solve = (use) => {
    const A = new Float64Array(N*N), B = new Float64Array(N);
    const add = (idx, cf, rhs, wt) => {
      for(let a=0;a<idx.length;a++){
        B[idx[a]] += wt*cf[a]*rhs;
        for(let b=0;b<idx.length;b++) A[idx[a]*N+idx[b]] += wt*cf[a]*cf[b];
      }
    };
    let wsum=0;
    meas.forEach((m, i) => {
      if(!use[i]) return;
      const [j,f0,f1] = hat(m.yc);
      add([(m.k+1)*ny+j, (m.k+1)*ny+j+1, m.k*ny+j, m.k*ny+j+1], [f0,f1,-f0,-f1], m.s, m.w);
      wsum += m.w;
    });
    const lam = Math.max(1e-3, wsum/N);
    const lamX = lam*0.8, lamY = lam*1.5;
    for(let j=0;j<ny;j++) for(let k=1;k<ns-1;k++) add([(k-1)*ny+j, k*ny+j, (k+1)*ny+j], [1,-2,1], 0, lamX);
    for(let k=0;k<ns;k++) for(let j=1;j<ny-1;j++) add([k*ny+j-1, k*ny+j, k*ny+j+1], [1,-2,1], 0, lamY);
    for(let j=0;j<ny;j++) add([kc*ny+j], [1], 0, lam*50+1);
    for(let i=0;i<N;i++) A[i*N+i] += 1e-4*(lam+1);
    return solveSPD(A, B, N);
  };
  let use = meas.map(() => 1);
  let sol = solve(use);
  if(!sol) return null;
  // kalıntısı büyük ölçümler (bir satır kaymış eşleşmeler) → at, yeniden çöz
  const pred = m => { const [j,f0,f1] = hat(m.yc); return (sol[(m.k+1)*ny+j]*f0 + sol[(m.k+1)*ny+j+1]*f1) - (sol[m.k*ny+j]*f0 + sol[m.k*ny+j+1]*f1); };
  let drop = 0;
  use = meas.map(m => { const ok = Math.abs(m.s - pred(m)) < pitch*0.22; if(!ok) drop++; return ok ? 1 : 0; });
  if(drop && drop < meas.length*0.6){
    const s2 = solve(use);
    if(s2) sol = s2;
  }
  const D = new Float32Array(N);
  const cap = h*0.12;
  for(let i=0;i<N;i++) D[i] = Math.max(-cap, Math.min(cap, sol[i]));
  return {ns, ny, D, w, h, pitch, nMeas:meas.length - drop, sw};
}
/* alanı (x,y) noktasında değerlendir (piksel cinsinden düşey kayma) */
function fieldAt(f, x, y){
  const kx = Math.max(0, Math.min(f.ns-1-1e-6, x/f.sw - 0.5));
  const k0 = kx|0, tk = kx-k0;
  const jy = Math.max(0, Math.min(f.ny-1-1e-6, y/(f.h-1)*(f.ny-1)));
  const j0 = jy|0, tj = jy-j0;
  const k1 = Math.min(f.ns-1, k0+1), j1 = Math.min(f.ny-1, j0+1);
  const D=f.D, ny=f.ny;
  return (D[k0*ny+j0]*(1-tj)+D[k0*ny+j1]*tj)*(1-tk) + (D[k1*ny+j0]*(1-tj)+D[k1*ny+j1]*tj)*tk;
}
function fieldMagnitude(f){
  let m=0; for(let i=0;i<f.D.length;i++) m=Math.max(m, Math.abs(f.D[i])); return m;
}

/* ---------- yatay hizalama: sol/sağ yazı kenarlarını dikleştir ----------
   Düz satırlara getirilmiş görüntüde her satırın sol/sağ uç noktası
   bulunur; sağlam doğru uydurma ile kenar çizgileri hesaplanır. */
function robustLineFit(pts){
  // pts: [[y, x, w]] → x = a + b*y ; IRLS + aykırı eleme
  if(pts.length < 5) return null;
  let a=0, b=0;
  let use = pts.map(()=>1);
  for(let it=0; it<6; it++){
    let sw=0, sy=0, sx=0, syy=0, sxy=0;
    pts.forEach((p,i)=>{ if(!use[i]) return; const w=p[2]; sw+=w; sy+=w*p[0]; sx+=w*p[1]; syy+=w*p[0]*p[0]; sxy+=w*p[0]*p[1]; });
    const den = sw*syy - sy*sy;
    if(sw<=0 || Math.abs(den)<1e-9) return null;
    b = (sw*sxy - sy*sx)/den; a = (sx - b*sy)/sw;
    const res = pts.map(p => Math.abs(p[1] - (a + b*p[0])));
    const med = quantile(res.filter((_,i)=>use[i]), 0.5);
    const lim = Math.max(2.5, med*2.5);
    use = res.map(r => r <= lim ? 1 : 0);
  }
  const nIn = use.reduce((s,v)=>s+v,0);
  return {a, b, inl: nIn/pts.length, n:nIn};
}
function estimateMargins(ink0, w, h, pitch, cut){
  const ink = new Float32Array(ink0);
  if(cut){ for(let y=0;y<h;y++){ const r=y*w; for(let x=0;x<cut.x0;x++) ink[r+x]=0; for(let x=cut.x1;x<w;x++) ink[r+x]=0; } }
  // ana metin bloğu: sütun profili
  const col = new Float32Array(w);
  for(let y=0;y<h;y++){ const r=y*w; for(let x=0;x<w;x++) col[x]+=ink[r+x]; }
  for(let x=0;x<w;x++) col[x]/=h;
  const cs = smooth1(col, Math.max(2, Math.round(pitch/2)));
  const cmax = quantile(cs, 0.9);
  if(cmax <= 0){ G.__mDbg='cmax0'; return null; }
  const on = x => cs[x] > cmax*0.12;
  let xa = (w/2)|0, xb = xa;
  const gapMax = Math.round(pitch*2.2);
  { let gap=0; for(let x=(w/2)|0; x>=0; x--){ if(on(x)){ xa=x; gap=0; } else if(++gap>gapMax) break; } }
  { let gap=0; for(let x=(w/2)|0; x<w; x++){ if(on(x)){ xb=x; gap=0; } else if(++gap>gapMax) break; } }
  if(xb - xa < w*0.3){ G.__mDbg='blok dar '+xa+'-'+xb; return null; }
  // satır bantları: satır profili
  const row = new Float32Array(h);
  for(let y=0;y<h;y++){ let s=0; const r=y*w; for(let x=xa;x<=xb;x++) s+=ink[r+x]; row[y]=s/(xb-xa+1); }
  const rs = smooth1(row, Math.max(1, Math.round(pitch/6)));
  const rmax = quantile(rs, 0.9);
  const lefts=[], rights=[];
  let y=0;
  while(y<h){
    if(rs[y] > rmax*0.25){
      let y2=y; while(y2<h && rs[y2] > rmax*0.25) y2++;
      const bh=y2-y;
      if(bh >= pitch*0.25 && bh <= pitch*1.6){
        // bant içi sütun mürekkebi
        const c = new Float32Array(w);
        const ca = Math.max(0, Math.round(xa-pitch)), cb = Math.min(w-1, Math.round(xb+pitch));   // tam sayı indeks!
        for(let yy=y; yy<y2; yy++){ const r=yy*w; for(let x=ca; x<=cb; x++) c[x]+=ink[r+x]; }
        const cc = smooth1(c, 2);
        const t = bh*0.12;
        // satırın kendi yazı koşusu: bloğun ortasından dışa doğru, ~1.2 satır aralığından geniş
        // boşlukta durulur → ayrık koyuluk (sırt gölgesi, komşu sayfa, kenar çizgisi) satır ucu sayılmaz
        let l=-1, r=-1;
        const gapM = Math.max(4, Math.round(pitch*1.2)), xm = Math.round((xa+xb)/2);
        let seed = -1;
        for(let d=0; d<=Math.max(xm-ca, cb-xm); d++){
          if(xm-d >= ca && cc[xm-d] > t){ seed = xm-d; break; }
          if(xm+d <= cb && cc[xm+d] > t){ seed = xm+d; break; }
        }
        if(seed >= 0){
          l = r = seed;
          for(let x=seed, g=0; x>=ca; x--){ if(cc[x] > t){ l = x; g = 0; } else if(++g > gapM) break; }
          for(let x=seed, g=0; x<=cb; x++){ if(cc[x] > t){ r = x; g = 0; } else if(++g > gapM) break; }
        }
        if(l>=0 && r-l > (xb-xa)*0.25){
          const ym=(y+y2)/2;
          lefts.push([ym, l, 1]); rights.push([ym, r, 1]);
        }
      }
      y=y2;
    } else y++;
  }
  if(lefts.length < 6){ G.__mDbg='bant '+lefts.length+' rmax='+rmax.toFixed(3); return null; }
  const L = robustLineFit(lefts), R = robustLineFit(rights);
  const bands = lefts.map((p, i) => ({ym:p[0], l:p[1], r:rights[i][1]}));
  return {L, R, xa, xb, n:lefts.length, bands};
}
/* yazı bloğu (düz satırlı koordinatlarda): sol/sağ hiza doğruları + ilk/son satır.
   Kitap sayfasında bu blok gerçek bir dikdörtgendir → perspektif ondan çıkarılır */
function textBlockFrom(m, pitch, w){
  if(!m || !m.L || m.L.inl < 0.55 || !m.bands || m.bands.length < 5) return null;
  if(Math.abs(m.L.b) > 0.35) return null;
  const tol = Math.max(4, pitch*1.2);
  const Lf = y => m.L.a + m.L.b*y;
  let Rf;
  if(m.R && m.R.inl > 0.6 && Math.abs(m.R.b - m.L.b) < 0.12) Rf = y => m.R.a + m.R.b*y;   // eğimler perspektif yüzünden biraz farklı olabilir; çok farklıysa sağ kenar tırtıklıdır
  else {                                    // sağı serbest (tırtıklı) metin: sola paralel
    const offs = m.bands.map(b => b.r - Lf(b.ym)).sort((a,b)=>a-b);
    const o = offs[Math.floor(offs.length*0.9)];
    Rf = y => Lf(y) + o;
  }
  const good = m.bands.filter(b => Math.abs(b.l - Lf(b.ym)) < tol || Math.abs(b.r - Rf(b.ym)) < tol)
                      .sort((a,b) => a.ym - b.ym);
  if(good.length < 5) return null;
  // en büyük ardışık grup (aradaki boşluk ≤ 3.5 satır)
  let best = null, cur = [good[0]];
  for(let i=1;i<good.length;i++){
    if(good[i].ym - good[i-1].ym <= pitch*3.5) cur.push(good[i]);
    else { if(!best || cur.length > best.length) best = cur; cur = [good[i]]; }
  }
  if(!best || cur.length > best.length) best = cur;
  if(best.length < 5) return null;
  const yTop = best[0].ym - pitch*0.65, yBot = best[best.length-1].ym + pitch*0.65;
  if(yBot - yTop < pitch*4) return null;
  const wTop = Rf(yTop) - Lf(yTop), wBot = Rf(yBot) - Lf(yBot);
  if(wTop < w*0.25 || wBot < w*0.25) return null;
  return {Lf, Rf, yTop, yBot, n: best.length};
}

/* ---------- ham (renkli) sayfa içinde kenar bandı kırpma ---------- */
function trimBoxByMap(pm, w, h, box, need, maxFrac){
  const bw=box.x1-box.x0, bh=box.y1-box.y0;
  const rows=new Float32Array(bh), cols=new Float32Array(bw);
  for(let y=0;y<bh;y++){ let s=0; const r=(box.y0+y)*w+box.x0; for(let x=0;x<bw;x++) s+=pm[r+x]; rows[y]=s/bw; }
  for(let x=0;x<bw;x++){ let s=0; for(let y=0;y<bh;y++) s+=pm[(box.y0+y)*w+box.x0+x]; cols[x]=s/bh; }
  const scan=(arr,from,step,limit)=>{ let i=0; while(i<limit && arr[from+i*step]<need) i++; return i; };
  const t=scan(rows,0,1,(bh*maxFrac)|0), b=scan(rows,bh-1,-1,(bh*maxFrac)|0);
  const l=scan(cols,0,1,(bw*maxFrac)|0), r=scan(cols,bw-1,-1,(bw*maxFrac)|0);
  const nb = {x0:box.x0+l, y0:box.y0+t, x1:box.x1-r, y1:box.y1-b};
  if(nb.x1-nb.x0 < bw*0.5 || nb.y1-nb.y0 < bh*0.5) return box;
  return nb;
}
function trimBoxRaw(d, w, h, box){
  const base=new Float32Array(w*h);
  for(let i=0;i<w*h;i++) base[i]=Math.min(d[i*4],d[i*4+1],d[i*4+2]);
  const core=[];
  const bw=box.x1-box.x0, bh=box.y1-box.y0;
  for(let y=box.y0+(bh*0.25|0); y<box.y0+(bh*0.75|0); y+=2)
    for(let x=box.x0+(bw*0.25|0); x<box.x0+(bw*0.75|0); x+=2) core.push(base[y*w+x]);
  const thr = quantile(core, 0.5)*0.55;
  const pm=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++) pm[i]=base[i]>thr?1:0;
  return trimBoxByMap(pm, w, h, box, 0.84, 0.16);
}
/* kitap sırtı: dar + koyu dikey vadi → oradan kes, komşu sayfayı at */
function spineBox(d, w, h, box){
  const bw=box.x1-box.x0;
  if(bw<60) return box;
  const prof=new Float32Array(bw);
  for(let x=0;x<bw;x++){
    let s=0;
    for(let y=box.y0;y<box.y1;y++){ const i=(y*w+box.x0+x)*4; s += 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; }
    prof[x]=s/(box.y1-box.y0);
  }
  const sm = smooth1(prof, Math.max(1, (bw/120)|0));
  const mid=[]; for(let x=(bw*0.3)|0;x<(bw*0.7)|0;x++) mid.push(sm[x]);
  const med=quantile(mid, 0.5);
  const thr=med-Math.max(18, med*0.10);
  let left=0, right=bw, i=0;
  while(i<bw){
    if(sm[i]<thr){
      let j=i; while(j<bw && sm[j]<thr) j++;
      const width=j-i, cx=(i+j)>>1;
      if(width < bw*0.10){
        if(cx < bw*0.42) left=Math.max(left,j);
        else if(cx > bw*0.58) right=Math.min(right,i);
      }
      i=j;
    } else i++;
  }
  if(left===0 && right===bw) return box;
  if(right-left < bw*0.5) return box;
  return {x0:box.x0+left, y0:box.y0, x1:box.x0+right, y1:box.y1};
}

/* ---------- görüntü iyileştirme ---------- */
/* kağıt rengi ızgarası (RGBA'dan): her blokta en parlak ~%15 pikselin
   ortalama rengi (tek tük parlama/gürültü referansı bozmaz), koyu bloklar
   (fotoğraf, yoğun yazı) komşudaki kağıttan alınır, sonra yumuşatılır.
   Döner: {R,G,B: Float32Array, bw, bh, bs} */
function bgGridRGBA(d, w, h){
  const bs = Math.max(8, Math.round(Math.max(w,h)/60));
  const bw = Math.max(2, Math.ceil(w/bs)), bh = Math.max(2, Math.ceil(h/bs));
  const R = new Float32Array(bw*bh), Gc = new Float32Array(bw*bh), B = new Float32Array(bw*bh), L = new Float32Array(bw*bh), Sd = new Float32Array(bw*bh);
  const hist = new Int32Array(64);
  for(let by=0; by<bh; by++){
    const y0=Math.min(h-1, by*bs), y1=Math.min(h, y0+bs);
    for(let bx=0; bx<bw; bx++){
      const x0=Math.min(w-1, bx*bs), x1=Math.min(w, x0+bs);
      hist.fill(0); let n=0;
      for(let y=y0; y<y1; y+=2){ let j=(y*w+x0)*4; for(let x=x0; x<x1; x+=2, j+=8){ hist[(d[j]*0.299+d[j+1]*0.587+d[j+2]*0.114)>>2]++; n++; } }
      let acc=0, t=63; const need=Math.max(1, n*0.15);
      for(; t>0; t--){ acc+=hist[t]; if(acc>=need) break; }
      const thr=t*4;
      let r=0,g=0,b=0,c=0,l1=0,l2=0;
      for(let y=y0; y<y1; y+=2){ let j=(y*w+x0)*4; for(let x=x0; x<x1; x+=2, j+=8){
        const l=d[j]*0.299+d[j+1]*0.587+d[j+2]*0.114;
        if(l >= thr){ r+=d[j]; g+=d[j+1]; b+=d[j+2]; c++; l1+=l; l2+=l*l; } } }
      const k=by*bw+bx; c=c||1;
      R[k]=r/c; Gc[k]=g/c; B[k]=b/c; L[k]=0.299*R[k]+0.587*Gc[k]+0.114*B[k];
      Sd[k]=Math.sqrt(Math.max(0, l2/c - (l1/c)*(l1/c)));
    }
  }
  // koyu bloklar (kağıt görünmeyen): 2 halka içindeki en parlak komşunun rengi.
  // İstisna: bloğun parlak pikselleri düz ve kağıt tonundaysa bu kağıdın kendisidir,
  // yalnız gölgede kalmıştır (sırt/kıvrım gölgesi) → kendi rengi kullanılır, gölge beyaza döner.
  const R2=new Float32Array(R), G2=new Float32Array(Gc), B2=new Float32Array(B);
  for(let by=0; by<bh; by++) for(let bx=0; bx<bw; bx++){
    const k=by*bw+bx; let bk=k;
    for(let dy=-2; dy<=2; dy++) for(let dx=-2; dx<=2; dx++){
      const yy=by+dy, xx=bx+dx;
      if(yy<0||yy>=bh||xx<0||xx>=bw) continue;
      const q=yy*bw+xx; if(L[q] > L[bk]) bk=q;
    }
    if(L[k] < L[bk]*0.9){
      // ton farkı (sıcak ışıkta sırt/sayfa kenarı turuncu-sarı görünür) şart değil: düz bölge kendi
      // rengine bölünür → hem gölge hem renk lekesi beyaza döner (eskiden sarı/turuncu şerit kalıyordu)
      // yalnız gerçekten koyu bloklar (fotoğraf, koyu kutu: komşu kağıdın %45'inden koyu) komşunun rengini alır;
      // sırt/kıvrım gölgesi (yazılı ya da yazısız) kendi rengine bölünür → beyaz olur, sarı/gri şerit kalmaz
      const shade = (Sd[k] < 7 || L[k] > L[bk]*0.55) && L[k] > L[bk]*0.45 && L[k] > 55;
      if(!shade){ R2[k]=R[bk]; G2[k]=Gc[bk]; B2[k]=B[bk]; }
    }
  }
  return {R: boxBlur(R2, bw, bh, 1, 2), G: boxBlur(G2, bw, bh, 1, 2), B: boxBlur(B2, bw, bh, 1, 2), bw, bh, bs};
}
/* keskinleştirme: 3 satırlık kayan tampon (tam kopya yok); alfa kanalı
   255 sabit olduğundan Laplace'ı 0 → tüm baytlar tek döngüde */
function sharpenRGB(data, w, h, amt){
  const rs=w*4;
  if(h < 3) return;
  let prev = data.slice(0, rs), cur = data.slice(rs, 2*rs);
  for(let y=1;y<h-1;y++){
    const base=y*rs, nb=base+rs;
    for(let x=4; x<rs-4; x++){
      const c = cur[x];
      data[base+x] = c + amt*(4*c - cur[x-4] - cur[x+4] - prev[x] - data[nb+x]);
    }
    const t = prev; prev = cur; cur = t;
    cur.set(data.subarray(nb, nb+rs));
  }
}
/* d: RGBA (yerinde değiştirilir)
   Her kanal kendi yerel kağıt rengine bölünür → kağıt her yerde nötr beyaz
   (sarı lamba, gölge gider). Beyaz noktası kağıdın ~%88'i: arka sayfadan
   sızan silik yazı ve hafif lekeler tamamen beyaza gider, yazı koyu ve net kalır. */
function enhanceRGBA(d, w, h, mode){
  if(mode === 'orig') return;
  const color = mode === 'color', gray = mode === 'gray';
  const Gd = bgGridRGBA(d, w, h);
  const gw = Gd.bw, gh = Gd.bh, bs = Gd.bs, BR = Gd.R, BG = Gd.G, BB = Gd.B;
  const curve = new Uint8ClampedArray(1024);   // girdi: kağıt ≈ 240
  for(let i=0;i<1024;i++){
    let t = (i - 28) / (212 - 28);
    t = Math.max(0, Math.min(1, t));
    curve[i] = Math.pow(t, 1.18)*255;
  }
  const docLut = new Uint8ClampedArray(1024);  // doc: net siyah yazı, saf beyaz kağıt (kenarlar yumuşak)
  for(let i=0;i<1024;i++){ const t=Math.max(0, Math.min(1, (i-115)/(200-115))); docLut[i] = 255*t*t*(3-2*t); }
  const xi = new Int32Array(w), xt = new Float32Array(w);
  for(let x=0;x<w;x++){ const fx=Math.max(0, Math.min(gw-1.001, (x+0.5)/bs-0.5)); xi[x]=fx|0; xt[x]=fx-(fx|0); }
  const fOf = v => v > 60 ? 240/v : 4;
  for(let y=0;y<h;y++){
    const fy=Math.max(0, Math.min(gh-1.001, (y+0.5)/bs-0.5)), y0=fy|0, ty=fy-y0;
    const r0=y0*gw, r1=r0+gw;
    let j=y*w*4;
    for(let x=0;x<w;x++, j+=4){
      const a=xi[x], t=xt[x];
      const w00=(1-t)*(1-ty), w01=t*(1-ty), w10=(1-t)*ty, w11=t*ty;
      const i00=r0+a, i10=r1+a;
      const fr = fOf(BR[i00]*w00 + BR[i00+1]*w01 + BR[i10]*w10 + BR[i10+1]*w11);
      const fg = fOf(BG[i00]*w00 + BG[i00+1]*w01 + BG[i10]*w10 + BG[i10+1]*w11);
      const fb = fOf(BB[i00]*w00 + BB[i00+1]*w01 + BB[i10]*w10 + BB[i10+1]*w11);
      let r=d[j]*fr, g=d[j+1]*fg, b=d[j+2]*fb;
      if(color){
        const avg=(r+g+b)/3;
        // koyu/nötr piksellerde (yazı) renk sıfırlanır → yazı üstünde renkli iz kalmaz
        const sat = avg < 150 ? 0.6 : 1.05;
        r = avg+(r-avg)*sat; g = avg+(g-avg)*sat; b = avg+(b-avg)*sat;
        d[j]   = curve[r<0?0:r>1023?1023:r|0];
        d[j+1] = curve[g<0?0:g>1023?1023:g|0];
        d[j+2] = curve[b<0?0:b>1023?1023:b|0];
      } else {
        let l = 0.299*r + 0.587*g + 0.114*b;
        l = l>1023 ? 1023 : l<0 ? 0 : l|0;
        const o = gray ? curve[l] : docLut[l];
        d[j]=d[j+1]=d[j+2]=o;
      }
    }
  }
  sharpenRGB(d, w, h, mode==='doc' ? 0.15 : 0.3);
}

/* ---------- kağıt rengi ---------- */
function paperColor(d, w, h){
  const rs=[],gs=[],bs=[];
  const step = Math.max(1, ((w*h)/40000)|0);
  for(let i=0;i<w*h;i+=step){
    const j=i*4, l=0.299*d[j]+0.587*d[j+1]+0.114*d[j+2];
    if(l>150){ rs.push(d[j]); gs.push(d[j+1]); bs.push(d[j+2]); }
  }
  if(!rs.length) return [245,245,245];
  return [quantile(rs,0.6), quantile(gs,0.6), quantile(bs,0.6)];
}
function fillAlpha(d, w, h, alpha, col){
  for(let i=0;i<w*h;i++){
    const a=alpha[i]; if(a<=0.01) continue;
    const j=i*4;
    d[j]=d[j]*(1-a)+col[0]*a; d[j+1]=d[j+1]*(1-a)+col[1]*a; d[j+2]=d[j+2]*(1-a)+col[2]*a;
  }
}

/* iyileştirme sonrası: kağıt ~beyaz, gölge/sırt bantları koyu kalır */
function trimEnhancedBox(d, w, h){
  const pm=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){ const j=i*4; pm[i] = (0.299*d[j]+0.587*d[j+1]+0.114*d[j+2]) > 168 ? 1 : 0; }
  return trimBoxByMap(pm, w, h, {x0:0,y0:0,x1:w,y1:h}, 0.86, 0.10);
}

function rotateCanvas(src, rot){
  if(!rot) return src;
  const c = (rot===90||rot===270) ? mkCanvas(src.height, src.width) : mkCanvas(src.width, src.height);
  const x=c.getContext('2d');
  x.translate(c.width/2, c.height/2);
  x.rotate(rot*Math.PI/180);
  x.drawImage(src, -src.width/2, -src.height/2);
  return c;
}

/* ============================================================
   TAM SAYFA İŞLEME
   opts: {mode, smartCrop, outW, outH}
   ============================================================ */
/* ---------- satır imzaları (tekrar sayfa tespiti) ----------
   Düzleştirilmiş düzlemde her yazı satırının yatay mürekkep profili (satırın kendi
   başı-sonu arasında 96 kutu, yüksek geçiren): kelime/boşluk düzeni. Aynı sayfanın iki
   çekiminde satırlar birebir eşleşir (kırpma, ölçek, kayma fark etmez); farklı sayfada eşleşmez. */
const LS_NB = 96;
function lineSigs(P){
  const m = P && P.margins, tb = P && P.tb;
  if(!m || !tb || !P.ink || !m.bands) return null;
  const ink = P.ink, w = P.bw, h = P.bh, pitch = P.pitch || 20, out = [];
  for(const b of m.bands){
    if(b.ym < tb.yTop || b.ym > tb.yBot) continue;
    const x0 = Math.max(0, b.l), x1 = Math.min(w-1, b.r);
    if(x1 - x0 < pitch*3) continue;
    const y0 = Math.max(0, Math.round(b.ym - pitch*0.32)), y1 = Math.min(h-1, Math.round(b.ym + pitch*0.32));
    const v = new Float32Array(LS_NB);
    for(let k=0;k<LS_NB;k++){
      const xa = Math.floor(x0 + (x1-x0)*k/LS_NB), xb = Math.max(xa+1, Math.floor(x0 + (x1-x0)*(k+1)/LS_NB));
      let sm = 0, n = 0;
      for(let y=y0; y<=y1; y++){ const r = y*w; for(let x=xa; x<xb; x++){ sm += ink[r+x]; n++; } }
      v[k] = n ? sm/n : 0;
    }
    const lo = smooth1(v, 4); let e = 0;
    for(let k=0;k<LS_NB;k++){ v[k] -= lo[k]; e += v[k]*v[k]; }
    e = Math.sqrt(e); if(e < 1e-4) continue;
    for(let k=0;k<LS_NB;k++) v[k] /= e;
    out.push(v);
  }
  return out.length >= 3 ? out : null;
}
/* iki sayfanın satır imzaları: eşleşen satır oranı (0..1). Satırlar aynı sırayla ve
   tutarlı bir satır kaymasıyla eşleşmeli. */
function lineMatch(A, B){
  if(!A || !B || A.length < 3 || B.length < 3) return 0;
  const sh = 2, votes = new Map(), best = [];
  for(let i=0;i<A.length;i++){
    let bv = 0, bj = -1;
    for(let j=0;j<B.length;j++){
      const a = A[i], b = B[j];
      for(let d=-sh; d<=sh; d++){
        let s = 0;
        for(let k=Math.max(0,d); k<LS_NB+Math.min(0,d); k++) s += a[k]*b[k-d];
        if(s > bv){ bv = s; bj = j; }
      }
    }
    best.push([bv, bj]);
    if(bv >= 0.6){ const o = bj - i; votes.set(o, (votes.get(o) || 0) + 1); }
  }
  let mo = 0, mc = 0; for(const [o, c] of votes) if(c > mc){ mc = c; mo = o; }
  let n = 0; for(let i=0;i<best.length;i++) if(best[i][0] >= 0.6 && Math.abs(best[i][1] - i - mo) <= 1) n++;
  return n / Math.min(A.length, B.length);
}
/* Kitap sırtı hangi yanda (sayfa sol mu, sağ mı)? Yazı bloğu düzleminde bloğun iki
   yanına doğru kaynak kare örneklenir. Sırt tarafında kenar boşluğundan sonra dar bir
   gölge vadisi ve ardından yine kağıt (komşu sayfa) gelir; dış tarafta sayfa kenarı →
   zemin ya da kadraj sonu. Dönen: {side:'L'|'R'|'', why} (L: sol sayfa, sırt sağda) */
function sideCues(sd, W, H, tq){
  const HT = homography([[0,0],[1,0],[1,1],[0,1]], tq);
  if(!HT) return {side:'', why:'H'};
  const NU = 300, NV = 28, U0 = -1.1, U1 = 2.1;
  const lum = new Float32Array(NU), outF = new Float32Array(NU);
  for(let iu=0; iu<NU; iu++){
    const u = U0 + (U1-U0)*iu/(NU-1);
    let s = 0, n = 0, o = 0;
    for(let iv=0; iv<NV; iv++){
      const [x, y] = applyH(HT, u, 0.08 + 0.84*iv/(NV-1));
      if(!(x >= 0 && y >= 0 && x < W-1 && y < H-1)){ o++; continue; }
      const i = ((y|0)*W + (x|0))*4;
      s += 0.299*sd[i] + 0.587*sd[i+1] + 0.114*sd[i+2]; n++;
    }
    lum[iu] = n ? s/n : 0; outF[iu] = o/NV;
  }
  if(G.__sideProf) G.__sideProf.push({lum:Array.from(lum), outF:Array.from(outF)});
  const ui = u => Math.max(0, Math.min(NU-1, Math.round((u - U0)/(U1 - U0)*(NU-1))));
  const marg = []; for(let k=ui(-0.12); k<=ui(1.12); k++) if(outF[k] < 0.3) marg.push(lum[k]);
  if(marg.length < 10) return {side:'', why:'kağıt yok'};
  const P = quantile(marg, 0.9);
  const du = (U1 - U0)/(NU-1);
  // bloğun kenarından dışa doğru: en derin çukur (ilk ~0.7 blok genişliği içinde),
  // çukurdan önceki (kenar boşluğu) ve sonraki (komşu sayfa ya da zemin) en parlak değer
  const scan = (start, step) => {
    const prof = [];
    for(let k = start; k >= 0 && k < NU && Math.abs(k - start)*du <= 1.0; k += step){
      if(outF[k] > 0.3) break;
      prof.push(lum[k]/P);
    }
    const lim = Math.min(prof.length, Math.round(0.7/du));
    if(lim < 3) return {kind:'kadraj', txt:'kadraj'};
    const after = new Float32Array(prof.length + 1);           // i'den sonraki en parlak
    for(let i=prof.length-1;i>=0;i--) after[i] = Math.max(after[i+1], prof[i]);
    let im = 0; for(let i=1;i<lim;i++) if(prof[i] < prof[im]) im = i;
    const m = prof[im], Bm = after[im+1];
    // en belirgin vadi: iki yanı da parlak (kenar boşluğu | komşu sayfa)
    let bd = -1, bi = 0, before = 0;
    for(let i=0;i<lim;i++){
      before = Math.max(before, prof[i]);
      const dpt = Math.min(before, after[i+1]) - prof[i];
      if(dpt > bd){ bd = dpt; bi = i; }
    }
    const txt = `ç${m.toFixed(2)}@${(im*du).toFixed(2)} s${Bm.toFixed(2)} v${bd.toFixed(2)}@${(bi*du).toFixed(2)}/${after[bi+1].toFixed(2)}${prof.length < Math.round(1.0/du) ? ' K' : ''}`;
    if((bd >= 0.10 && after[bi+1] >= 0.70) || (Bm - m >= 0.25 && Bm >= 0.9)) return {kind:'komşu', txt};
    // sayfanın dış kenarı: kağıttan koyu zemine KESKİN geçiş (sırt gölgesi ise yavaş koyulaşır),
    // ardından zemin bir süre koyu kalır
    let i2 = -1; for(let i=0;i<prof.length;i++) if(prof[i] < 0.65){ i2 = i; break; }
    let i1 = -1; for(let i=i2-1; i>=0; i--) if(prof[i] >= 0.86){ i1 = i; break; }
    if(i1 < 0 && i2 >= 0 && i2 <= 3) i1 = 0;            // kenar boşluğu çok dar: kenar bloğun hemen yanında
    if(i1 >= 0 && i2 >= 0 && i2 - i1 <= 3){
      let run = 0, j = i2;
      for(; j<prof.length && prof[j] < 0.55; j++) run++;
      const toFrame = j >= prof.length && prof.length < Math.round(1.0/du);
      if(run*du >= 0.08 || (toFrame && run*du >= 0.02)) return {kind:'kenar', txt: txt + ` kenar@${(i1*du).toFixed(2)}`};
    }
    if(m < 0.7 && Bm < 0.72) return {kind:'zemin', txt};
    return {kind:'?', txt};
  };
  const Ls = scan(ui(0), -1), Rs = scan(ui(1), 1);
  const why = `sol:${Ls.kind} ${Ls.txt} · sağ:${Rs.kind} ${Rs.txt}`;
  // sırt (komşu sayfa) bir yanda ya da sayfanın dış kenarı öbür yanda; çelişki → bilinmiyor
  // komşu-sayfa ipucu tek başına yetmez (açık renk dantel örtü de vadi + parlaklık verir):
  // öbür yanda koyu zemin ya da keskin sayfa kenarı da görülmeli. Keskin dış kenar tek başına yeter.
  const gutL = Ls.kind === 'komşu', gutR = Rs.kind === 'komşu', outL = Ls.kind === 'kenar', outR = Rs.kind === 'kenar';
  const bgL = outL || Ls.kind === 'zemin', bgR = outR || Rs.kind === 'zemin';
  const isR = (outR || (gutL && bgR)) && !gutR && !outL, isL = (outL || (gutR && bgL)) && !gutL && !outR;
  if(isR && !isL) return {side:'R', why};
  if(isL && !isR) return {side:'L', why};
  return {side:'', why};
}
/* içerik koordinatı → kaynak eşlemesi (P düzlemi, içerik kutusu c) */
function makeMap(P, c){
  const hmap = marginMap(P);
  return (x, y) => { let X = c.x0 + x; const Y = c.y0 + y; if(hmap) X = hmap(X, Y); return P.toSrc(X, Y); };
}
/* EKSİK YAZI: sayfa düzleminde (A) yazıya benzeyen mürekkebin ne kadarı çıktının içerik kutusunun
   DIŞINDA kalıyor? (0: hepsi alındı). Kenar şeritleri/gölge (düz koyuluk) yazı sayılmaz:
   yatayda kısa aralıkta çok kez açılıp kapanan mürekkep yazıdır. */
function leftoverInk(A, map, c){
  if(!A.ink || !c) return 0;
  const poly = [], NP = 14;
  for(let i=0;i<NP;i++) poly.push(map(c.w*i/NP, 0));
  for(let i=0;i<NP;i++) poly.push(map(c.w, c.h*i/NP));
  for(let i=0;i<NP;i++) poly.push(map(c.w*(1-i/NP), c.h));
  for(let i=0;i<NP;i++) poly.push(map(0, c.h*(1-i/NP)));
  if(!poly.every(p => isFinite(p[0]) && isFinite(p[1]))) return 0;
  const pip = (x, y) => { let ins = false; for(let i=0, j=poly.length-1; i<poly.length; j=i++){ const a = poly[i], b = poly[j];
    if(((a[1] > y) !== (b[1] > y)) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1]) + a[0]) ins = !ins; } return ins; };
  const ink = A.ink, w = A.bw, h = A.bh, P = Math.max(6, Math.round(A.pitch || 20));
  const mx = Math.round(w*0.03), my = Math.round(h*0.03);
  let tot = 0, out = 0;
  for(let y=my; y<h-my; y+=3){
    const r = y*w;
    for(let x=mx; x<w-mx; x+=3){
      const v = ink[r+x]; if(v < 0.3) continue;
      let tr = 0, prev = 1;
      for(let xx=Math.max(0, x-P); xx<Math.min(w, x+P); xx++){ const on = ink[r+xx] > 0.3 ? 1 : ink[r+xx] < 0.1 ? 0 : prev; if(on !== prev){ tr++; prev = on; } }
      if(tr < 5) continue;                                       // düz koyuluk: yazı değil
      tot += v;
      const p = A.toSrc(x, y);
      if(!pip(p[0], p[1])) out += v;
    }
  }
  return tot > 20 ? out/tot : 0;
}
function processCanvas(src, opts){
  const t0 = Date.now();
  // hızlı kontrol (canlı çekimde 'bip' kararı): küçük kaynak, küçük düzlemler, çıktı yok
  const quick = !!opts.quick;
  let qScale = 1;
  if(quick){
    qScale = Math.min(1, 1280/Math.max(src.width, src.height));
    if(qScale < 1) src = downscale(src, Math.round(src.width*qScale), Math.round(src.height*qScale));
  }
  const W = src.width, H = src.height;
  const outW = (opts.outW || 1240)*(quick ? 0.5 : 1)|0, outH = (opts.outH || 1754)*(quick ? 0.5 : 1)|0;
  const issues = [], dbg = [];
  let tl = Date.now(); const tms = [];
  const T = name => { const n=Date.now(); tms.push(name+':'+(n-tl)); tl=n; };
  const sd = imgData(src).data;
  let det = null, quad = null;
  if(opts.smartCrop){
    det = detectPage(src, 240);
    if(det.ok) quad = det.quad;
    dbg.push('tespit:' + (det.ok ? 'ok' : det.reason));
  }
  T('tespit');
  if(!quad) quad = [[0,0],[W-1,0],[W-1,H-1],[0,H-1]];

  // ---- A) kaba düzleştirme (sayfa dörtgeni) + satır alanı + yan sayfa + yazı bloğu
  const arA = det && det.ok ? estimateAspect(quad, W, H) : W/H;
  const srcPageH = (dist(quad[0],quad[3]) + dist(quad[1],quad[2]))/2;
  const HaA = quick ? 560 : Math.round(Math.max(800, Math.min(1200, srcPageH*1.2)));
  const A = analyzePlane(sd, W, H, quad, arA, HaA, opts.smartCrop, opts.smartCrop && opts.dewarp !== false, dbg, 'A');
  T('A');

  // ---- B) yazı bloğu bulunduysa: perspektif YAZI BLOĞUNDAN yeniden hesaplanır
  //         (sayfa kenarı/arka plan ne olursa olsun doğru), sonra içerik kutusu
  let B = null, content = null, tqSrc = null;
  // hızlı kontrolde B yalnız A yazıyı üstten/alttan kesiyorsa (sayfa dörtgeni kısa) çalışır
  const aCutsA = A.tb && ((A.bh - A.tb.yBot) < 1.5*(A.pitch || 20) || A.tb.yTop < 1.5*(A.pitch || 20));
  // sayfa kadrajda tam (dörtgen hiçbir yandan kesilmiyor) ve A'da yazı kenarları dik ise A'nın
  // perspektifi zaten doğrudur → B (yazı bloğundan perspektif) gereksiz ve riskli: sayfanın dışına
  // taşan payı dantel/zemin/sayfa kenarı içerir. B yalnız sayfa kenarı görünmüyorsa ya da A eğikse.
  // (kitapta sırt tarafında maske komşu sayfayla kadraj kenarına bağlanır → det.clipped değil, dörtgen köşelerine bakılır)
  const mgn = 0.01*Math.min(W, H);
  const pageCut = det && det.ok ? [0,1,2,3].map(e => { const a = det.quad[e], b = det.quad[(e+1)%4], m = 0.012*Math.min(W, H);
    return e === 0 ? (a[1] < m && b[1] < m) : e === 1 ? (a[0] > W-1-m && b[0] > W-1-m) : e === 2 ? (a[1] > H-1-m && b[1] > H-1-m) : (a[0] < m && b[0] < m); }) : null;
  const pageOk = !!(det && det.ok && det.quad.every(([x, y]) => x > mgn && y > mgn && x < W-1-mgn && y < H-1-mgn));
  const mA = A.margins;
  const aStraight = !!(A.tb && mA && mA.L && mA.L.inl > 0.7 && Math.abs(mA.L.b) < 0.04 &&
                       (!mA.R || mA.R.inl < 0.6 || Math.abs(mA.R.b) < 0.04) && A.tb.n >= 8 && !aCutsA);
  if(pageOk && aStraight) dbg.push('A yeterli (sayfa tam, kenarlar dik)');
  if(A.tb){
    const tq = [[A.tb.Lf(A.tb.yTop), A.tb.yTop], [A.tb.Rf(A.tb.yTop), A.tb.yTop],
                [A.tb.Rf(A.tb.yBot), A.tb.yBot], [A.tb.Lf(A.tb.yBot), A.tb.yBot]].map(([x,y]) => A.toSrc(x, y));
    if(tq.every(p => isFinite(p[0]) && isFinite(p[1])) && isConvex(tq)) tqSrc = tq;
  }
  if(tqSrc && !(pageOk && aStraight)){
    const tq = tqSrc;
    {
      const arT = estimateAspect(tq, W, H);
      // yazı bloğu düzleminde genişletilmiş bölge. Pay, A'da bulunan sayfanın bloğa göre
      // gerçek uzantısından gelir: blok sayfanın yalnız bir kısmını kapsasa da (ör. arada
      // girintili alıntı) bloğun altındaki/üstündeki satırlar düzlemin dışında kalmaz.
      const yMidA = (A.tb.yTop + A.tb.yBot)/2;
      const bwA = Math.max(1, A.tb.Rf(yMidA) - A.tb.Lf(yMidA)), bhA = Math.max(1, A.tb.yBot - A.tb.yTop);
      const clampE = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      // sayfa tam görünüyorsa B düzlemi sayfanın içinde kalır (alt sınırlar küçük); yoksa eski sabit paylar
      const lo = pageOk ? [0.03, 0.03, 0.04, 0.04] : [0.16, 0.16, 0.35, 0.3], pd = pageOk ? 0.015 : 0.04;
      const exL = clampE(A.tb.Lf(yMidA)/bwA + pd, lo[0], 0.7);
      const exR = clampE((A.bw - A.tb.Rf(yMidA))/bwA + pd, lo[1], 0.7);
      const eyT = clampE(A.tb.yTop/bhA + pd, lo[2], 1.6);
      const eyB = clampE((A.bh - A.tb.yBot)/bhA + pd, lo[3], 1.6);
      const HT = (!quick || aCutsA) ? homography([[0,0],[1,0],[1,1],[0,1]], tq) : null;
      if(HT){
        const qB = [[-exL,-eyT],[1+exR,-eyT],[1+exR,1+eyB],[-exL,1+eyB]].map(([u,v]) => applyH(HT, u, v));
        const blockSrcH = (dist(tq[0],tq[3]) + dist(tq[1],tq[2]))/2;
        const tot = 1+eyT+eyB, totX = 1+exL+exR;
        const HtB = quick ? Math.round(Math.min(Math.max(340, Math.min(480, blockSrcH*0.55)), 1100/tot))
                          : Math.round(Math.min(Math.max(700, Math.min(1000, blockSrcH*1.1)), 2200/tot));
        const HbB = Math.round(HtB*tot);
        const arB = arT*totX/tot;
        if(qB.every(p => isFinite(p[0]) && isFinite(p[1])) && isConvex(qB)){
          const sl = 0.06;                       // beklenen yazı sütunu (± pay)
          dbg.push(`B pay L${exL.toFixed(2)} R${exR.toFixed(2)} Ü${eyT.toFixed(2)} A${eyB.toFixed(2)}`);
          B = analyzePlane(sd, W, H, qB, arB, HbB, false, true, dbg, 'B',
                           {x0:Math.max(0,(exL-sl)/totX), x1:Math.min(1,(exL+1+sl)/totX), y0:Math.max(0,(eyT-0.05)/tot), y1:Math.min(1,(1+eyT+0.05)/tot)});
          // A düzlemi yazıyı üstten/alttan kesiyorsa (sayfa dörtgeni kısa) B daha az satır bulsa da
          // tercih edilir: B'nin perspektifi zaten A'nın bloğundan, kendi bloğu yalnız içerik kutusu için
          const aCuts = (A.bh - A.tb.yBot) < 1.5*(A.pitch || 20) || A.tb.yTop < 1.5*(A.pitch || 20);
          const okB = B.tb && B.tb.n >= 5 && (B.tb.n >= A.tb.n*0.6 || aCuts);
          if(okB && aCuts && B.tb.n < A.tb.n*0.6) dbg.push('A yazıyı kesiyor → B');
          if(okB) content = contentBox(B, dbg);
          else { dbg.push('B geçersiz → A'); B = null; }
        }
      }
    }
  }
  T('B');

  // B olmadıysa: A'nın yazı bloğundan içerik kutusu (perspektif daha kaba ama arka plan yine dışarıda)
  let P = B;
  if(!content && A.tb && A.ink){ content = contentBox(A, dbg); P = A; }
  // eksik yazı denetimi; B kullanılıyorsa A'nın içerik kutusuyla da karşılaştırılır, daha azını
  // dışarıda bırakan seçilir (sayfanın kıvrık ya da gölgede kalan kısmı atılmasın)
  let leftover = 0;
  if(content && A.ink){
    leftover = leftoverInk(A, makeMap(P, content), content);
    if(P === B && A.tb){
      const cA = contentBox(A, []);
      const lA = leftoverInk(A, makeMap(A, cA), cA);
      dbg.push(`dışarıda kalan yazı B:%${(leftover*100)|0} A:%${(lA*100)|0}`);
      if(lA + 0.03 < leftover){ P = A; B = null; content = cA; leftover = lA; dbg.push('A seçildi (daha az yazı dışarıda)'); }
    } else dbg.push(`dışarıda kalan yazı %${(leftover*100)|0}`);
  }
  // ---- son eşleme: çıktı pikseli → kaynak
  let mapOut, srcSpanH, mode;
  if(content){
    mode = 'yazı';
    const c = content;
    const hmap = marginMap(P);
    mapOut = (x, y) => {               // içerik koordinatı (P'nin düz-satır birimi)
      let X = c.x0 + x, Y = c.y0 + y;
      if(hmap) X = hmap(X, Y);
      return P.toSrc(X, Y);
    };
    srcSpanH = c.h * P.srcPerPx;
  } else {
    mode = 'sayfa';
    if(det && !det.ok) issues.push({code:'nopage', side:-1});
    const P = A, hmap = marginMap(P);
    mapOut = (x, y) => { let X = x; if(hmap) X = hmap(X, y); return P.toSrc(X, y); };
    content = {x0:0, y0:0, w:P.bw, h:P.bh, pitch: P.pitch};
    srcSpanH = P.bh * P.srcPerPx;
  }
  dbg.push('mod:' + mode);

  // ---- canlı çekim doğrulaması için ölçüler: eğiklik, sayfa yanı, kadraj payı
  let tilt = 1, side = {side:'', why:''}, room = null;
  if(tqSrc){
    const wT = dist(tqSrc[0],tqSrc[1]), wB = dist(tqSrc[3],tqSrc[2]), hL = dist(tqSrc[0],tqSrc[3]), hR = dist(tqSrc[1],tqSrc[2]);
    tilt = Math.max(wT/wB, wB/wT, hL/hR, hR/hL);
    side = sideCues(sd, W, H, tqSrc);
  }
  if(mode === 'yazı'){
    // içerik kutusunun her yanında kadrajın kaç satır aralığı daha gördüğü (sayfa no, başlık için)
    const tolR = 0.004*Math.min(W,H), pc = content.pitch || 20;
    const inside = p => isFinite(p[0]) && isFinite(p[1]) && p[0] >= tolR && p[1] >= tolR && p[0] <= W-1-tolR && p[1] <= H-1-tolR;
    const sideIn = (e, k) => {
      const off = k*pc;
      for(let t=0.03; t<=0.98; t+=0.0475){
        let x, y;
        if(e === 0){ x = t*content.w; y = -off; } else if(e === 1){ x = content.w + off; y = t*content.h; }
        else if(e === 2){ x = t*content.w; y = content.h + off; } else { x = -off; y = t*content.h; }
        if(!inside(mapOut(x, y))) return false;
      }
      return true;
    };
    room = [0,1,2,3].map(e => { let r = -1; for(const k of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]){ if(sideIn(e, k)) r = k; else break; } return r; });
  }
  dbg.push(`yan:${side.side||'?'} (${side.why}) eğiklik ${tilt.toFixed(2)}${room ? ' pay ' + room.join('/') : ''}`);

  // ---- yerleşim: tüm sayfalarda tutarlı yazı boyutu (satır aralığına göre), kenar boşlukları beyaz
  const mx = content === null ? 0 : (mode === 'yazı' ? 0.075 : 0), myT = mode === 'yazı' ? 0.06 : 0, myB = mode === 'yazı' ? 0.06 : 0;
  const availW = outW*(1-2*mx), availH = outH*(1-myT-myB);
  let s = Math.min(availW/content.w, availH/content.h);
  // yazı boyutu tutarlılığı yalnız sayfanın bir kısmını kaplayan içerikte (bölüm sonu, kısa sayfa):
  // kapak/büyük başlık gibi sayfayı dolduran içerik satır aralığına göre küçültülmez, sayfaya sığdırılır
  const contentFrac = det && det.ok && mode === 'yazı' ? (content.h*P.srcPerPx)/Math.max(1, srcPageH) : 0;
  if(mode === 'yazı' && content.pitch && contentFrac < 0.6){
    const sPitch = (outW*0.86/26) / content.pitch;      // ~26 satır aralığı = sayfa genişliği
    s = Math.min(s, sPitch*1.0);
  }
  const fw = Math.max(16, Math.round(content.w*s)), fh = Math.max(16, Math.round(content.h*s));
  const grid = buildGrid(fw, fh, 8, (u, v) => mapOut(u/s, v/s));
  const mag = fh / Math.max(1, srcSpanH);
  const pageData = remap(sd, W, H, fw, fh, grid, mag > 1.15, mode === 'yazı' ? [255,255,255] : null);
  T('örnekle');

  // ---- parmak / sayfa dışı (1/4 çözünürlük)
  const Q = 4, qw = Math.ceil(fw/Q), qh = Math.ceil(fh/Q);
  const qRaw = shrinkRGB(pageData, fw, fh, Q);
  const paperRaw = paperColorQ(qRaw, qw*qh);
  const paperL = 0.299*paperRaw[0]+0.587*paperRaw[1]+0.114*paperRaw[2];
  let fillQ = null, fingerQ = null;
  if(opts.smartCrop){
    const localPaper = localPaperGrid(qRaw, qw, qh);
    const cand = new Uint8Array(qw*qh);
    const comp = mode === 'sayfa' && det && det.ok ? det.compFilled : null;
    for(let qy=0; qy<qh; qy++) for(let qx=0; qx<qw; qx++){
      const i = qy*qw+qx, j = i*3;
      const r=qRaw[j], gg=qRaw[j+1], b=qRaw[j+2], l=0.299*r+0.587*gg+0.114*b;
      const ref = skinRef(localPaper(qx+0.5, qy+0.5));
      const skin = isSkinRef(r,gg,b,ref);
      const blueish = b*ref.wb - r*ref.wr > 18 && l < ref.L*0.85;
      const notPaper = skin || (comp && (l < paperL*0.5 || blueish));
      if(!notPaper) continue;
      let outsideComp = true;
      if(comp){
        const [sx, sy] = gridAt(grid, qx*Q+Q/2, qy*Q+Q/2);
        const cx=Math.round(sx*det.sc), cy=Math.round(sy*det.sc);
        for(let dy=-1; dy<=1 && outsideComp; dy++) for(let dx=-1; dx<=1; dx++){
          const xx=cx+dx, yy=cy+dy;
          if(xx>=0 && yy>=0 && xx<det.sw && yy<det.sh && comp[yy*det.sw+xx]){ outsideComp=false; break; }
        }
      }
      if(outsideComp || skin) cand[i] = skin ? 2 : 1;
    }
    const bin = new Uint8Array(qw*qh); for(let i=0;i<qw*qh;i++) bin[i] = cand[i] ? 1 : 0;
    const LC = labelComponents(bin, qw, qh);
    const touch = new Uint8Array(LC.count+1), skinCnt = new Int32Array(LC.count+1);
    for(let qx=0;qx<qw;qx++){ touch[LC.labels[qx]]=1; touch[LC.labels[(qh-1)*qw+qx]]=1; }
    for(let qy=0;qy<qh;qy++){ touch[LC.labels[qy*qw]]=1; touch[LC.labels[qy*qw+qw-1]]=1; }
    for(let i=0;i<qw*qh;i++) if(cand[i]===2) skinCnt[LC.labels[i]]++;
    const Lq = new Float32Array(qw*qh);
    for(let i=0;i<qw*qh;i++) Lq[i]=0.299*qRaw[i*3]+0.587*qRaw[i*3+1]+0.114*qRaw[i*3+2];
    const texS = new Float32Array(LC.count+1), texN = new Int32Array(LC.count+1);
    for(let y=1;y<qh-1;y++) for(let x=1;x<qw-1;x++){
      const i=y*qw+x, l=LC.labels[i];
      if(!l) continue;
      texS[l] += Math.abs(Lq[i+qw]-Lq[i-qw]) + Math.abs(Lq[i+1]-Lq[i-1]);
      texN[l]++;
    }
    const textured = l => texN[l] > 8 && texS[l]/texN[l] > paperL*0.11;
    const minF = Math.max(6, qw*qh*0.0008);
    fillQ = new Uint8Array(qw*qh); fingerQ = new Uint8Array(qw*qh);
    let anyF=false, anyFi=false;
    for(let i=0;i<qw*qh;i++){
      const l = LC.labels[i];
      if(!l || !touch[l]) continue;
      if(skinCnt[l] > LC.sizes[l]*0.3 && textured(l)) continue;
      fillQ[i]=1; anyF=true;
      if(skinCnt[l] >= minF && skinCnt[l] > LC.sizes[l]*0.3){ fingerQ[i]=1; anyFi=true; }
    }
    if(!anyF) fillQ = null;
    if(!anyFi) fingerQ = null;
    if(fillQ){
      let nf=0; for(let i=0;i<qw*qh;i++) nf+=fillQ[i];
      if(nf > qw*qh*0.2){ dbg.push(`doldurma iptal (%${(nf*100/(qw*qh))|0})`); fillQ = null; fingerQ = null; }
    }
  }
  T('maske');
  enhanceRGBA(pageData, fw, fh, opts.mode);
  if(fillQ){
    let m = dilate1(fillQ, qw, qh);
    if(fingerQ) for(let k=0;k<2;k++) m = dilate1(m, qw, qh);
    const a = new Float32Array(qw*qh); for(let i=0;i<qw*qh;i++) a[i]=m[i];
    const alpha = boxBlur(a, qw, qh, 1, 1);
    for(let i=0;i<qw*qh;i++) alpha[i] = Math.min(1, alpha[i]*1.5);
    fillAlphaQ(pageData, fw, fh, alpha, qw, qh, Q, paperColor(pageData, fw, fh));
  }
  T('iyileştir');
  const pageCanvas = putRGBA(pageData, fw, fh);
  let fbox = {x0:0,y0:0,x1:fw,y1:fh};
  if(mode === 'sayfa' && opts.smartCrop && opts.mode !== 'orig') fbox = trimEnhancedBox(pageData, fw, fh);

  // ---- sorunlar
  const st = inkStatsQ(pageData, fw, fh, Q, fbox, fingerQ);
  if(mode === 'yazı'){
    // içerik kutusu kenarları kaynak karede kadraj kenarına değiyor/taşıyorsa → kesik
    const tolF = 0.012*Math.min(W,H);
    const near = (p) => p[0] < tolF || p[1] < tolF || p[0] > W-1-tolF || p[1] > H-1-tolF;
    const sides = [[0,0,1,0],[1,0,1,1],[0,1,1,1],[0,0,0,1]];      // üst, sağ, alt, sol
    sides.forEach(([ax,ay,bx,by], e) => {
      let n=0, k=0;
      for(let t=0.05; t<=0.95; t+=0.05){
        const x = (ax + (bx-ax)*t)*content.w, y = (ay + (by-ay)*t)*content.h;
        k++; if(near(mapOut(x, y))) n++;
      }
      if(n/k > 0.25 && st.edge[e] > 0.01) issues.push({code:'cut', side:e});
    });
    // A düzlemi = kadrajın içindeki sayfanın kendisi: düzlem kenarına ulaşmak sayfa kenarına ulaşmaktır, kesik değil
    const planeIsPage = P === A && pageOk;
    if(content.cutTop && !planeIsPage) issues.push({code:'cut', side:0});
    if(content.cutBot && !planeIsPage) issues.push({code:'cut', side:2});
  } else if(det && det.ok){
    for(let e=0;e<4;e++){
      if(A.neighborSide[e]) continue;
      if((det.clipped[e] && st.edge[e] > 0.03) || ((e===0 || e===2) && st.edge[e] > 0.4)) issues.push({code:'cut', side:e});
    }
  }
  if(st.fingerOnText > 0.002) issues.push({code:'finger', side:-1});
  T('analiz');
  if(quick){
    const metricsQ = {sharp: st.sharp, crisp: st.crisp, inkFrac: st.frac, ms: Date.now()-t0, mode, quick: true,
                      lines: (mode === 'yazı' ? P : A).tb ? (mode === 'yazı' ? P : A).tb.n : 0, tilt, room, side: side.side,
                      srcPitch: content.pitch ? content.pitch*(mode === 'yazı' ? P : A).srcPerPx/qScale : 0,
                      extraTop: content.extraTop || 0, extraBot: content.extraBot || 0, pageCut, leftover};
    dbg.push(tms.join(' ')); dbg.push(`hızlı ${W}x${H}, ${metricsQ.ms} ms`);
    return {canvas: null, issues, metrics: metricsQ, dbg: dbg.join(' | '), lineSig: mode === 'yazı' ? lineSigs(P) : null};
  }
  const PP = mode === 'yazı' ? P : A;
  const metrics = {sharp: st.sharp, crisp: st.crisp, inkFrac: st.frac, ms: 0, mode,
                   lines: PP && PP.tb ? PP.tb.n : 0, tilt, room, side: side.side,
                   srcPitch: content.pitch && PP ? content.pitch*PP.srcPerPx/qScale : 0,
                   extraTop: content.extraTop || 0, extraBot: content.extraBot || 0, pageCut, leftover};

  // ---- tek tip çıktı sayfası (tam outW×outH)
  let out;
  if(mode === 'yazı'){
    out = mkCanvas(outW, outH);
    const ox = ctx2d(out);
    ox.fillStyle = '#ffffff'; ox.fillRect(0, 0, outW, outH);
    if(opts.mode === 'orig'){ const pc = paperColor(pageData, fw, fh); ox.fillStyle = `rgb(${pc[0]|0},${pc[1]|0},${pc[2]|0})`; ox.fillRect(0,0,outW,outH); }
    const dx = Math.round((outW - fw)/2);
    const dy = Math.round(outH*myT + Math.max(0, (availH - fh))*0.15);
    ox.drawImage(pageCanvas, dx, dy);
  } else {
    out = toFinalPage(pageCanvas, fbox, outW, outH);
  }
  T('son');
  metrics.ms = Date.now()-t0;
  dbg.push(tms.join(' '));
  dbg.push(`${W}x${H} → ${fw}x${fh} → ${outW}x${outH}, ${metrics.ms} ms`);
  return {canvas: out, issues, metrics, dbg: dbg.join(' | '), lineSig: mode === 'yazı' ? lineSigs(P) : null};
}

/* bir düzlemi (dörtgen → dikdörtgen) düzleştir, satır alanını, yan sayfa
   kesimini, kenar hizalarını ve yazı bloğunu çıkar.
   Dönen nesne: {toSrc(x,y): düz-satır koordinatı → kaynak, bw, bh, fields,
   margins, tb, pitch, ink, srcPerPx, neighborSide} */
function analyzePlane(sd, W, H, quad, ar, Ha, trim, dewarp, dbg, tag, focus){
  const Wa = Math.max(64, Math.round(Ha*ar));
  const hm = homography([[0,0],[Wa,0],[Wa,Ha],[0,Ha]], quad);
  if(!hm) throw new Error('homografi');
  const MK = [254, 1, 253];                     // kadraj dışı işareti
  const rect = remap(sd, W, H, Wa, Ha, buildGrid(Wa, Ha, 8, (u,v) => applyH(hm, u, v)), false, MK);
  {
    // kadraj dışını görüntünün kendi kağıt rengiyle doldur (yapay kenar oluşmasın)
    const isMk = j => rect[j]===MK[0] && rect[j+1]===MK[1] && rect[j+2]===MK[2];
    const rs=[], gs=[], bs=[];
    for(let j=0;j<rect.length;j+=4*7){ if(isMk(j)) continue; const l=0.299*rect[j]+0.587*rect[j+1]+0.114*rect[j+2]; if(l>120){ rs.push(rect[j]); gs.push(rect[j+1]); bs.push(rect[j+2]); } }
    const pc = rs.length ? [quantile(rs,0.7), quantile(gs,0.7), quantile(bs,0.7)] : [240,240,240];
    for(let j=0;j<rect.length;j+=4) if(isMk(j)){ rect[j]=pc[0]; rect[j+1]=pc[1]; rect[j+2]=pc[2]; }
  }
  let box = {x0:0, y0:0, x1:Wa, y1:Ha};
  if(trim){ box = trimBoxRaw(rect, Wa, Ha, box); box = spineBox(rect, Wa, Ha, box); }
  let bw = box.x1-box.x0;
  const bh = box.y1-box.y0;
  const neighborSide = [false,false,false,false];
  let fields = [], margins = null, tb = null, pitch = 0, inkD = null, gD = null;
  const chainY = (fl, x, y) => { let yy = y; for(let i=fl.length-1; i>=0; i--) yy = yy + fieldAt(fl[i], x, yy); return yy; };
  const grayBox = () => {
    const g = new Float32Array(bw*bh);
    for(let y=0;y<bh;y++) for(let x=0;x<bw;x++){
      const i=((box.y0+y)*Wa + box.x0+x)*4;
      g[y*bw+x] = 0.299*rect[i]+0.587*rect[i+1]+0.114*rect[i+2];
    }
    return g;
  };
  const focusMask = (ink) => {
    if(!focus) return ink;
    const o = new Float32Array(ink.length);
    const x0=Math.max(0,Math.round(focus.x0*bw)), x1=Math.min(bw,Math.round(focus.x1*bw));
    const y0=Math.max(0,Math.round(focus.y0*bh)), y1=Math.min(bh,Math.round(focus.y1*bh));
    for(let y=y0;y<y1;y++){ const r=y*bw; for(let x=x0;x<x1;x++) o[r+x]=ink[r+x]; }
    return o;
  };
  const runFields = (g0, ink0) => {
    const fl = []; let g = g0, ink = ink0;
    const inkF0 = focusMask(ink0); let inkF = inkF0;
    for(let pass=0; pass<2; pass++){
      G.__fieldWhy = '';
      const f = estimateTextField(inkF, bw, bh);
      if(!f){ if(!pass) dbg.push(tag+' satır yok ' + G.__fieldWhy); break; }
      fl.push(f);
      dbg.push(`${tag} p=${f.pitch.toFixed(1)} n=${f.nMeas} max=${fieldMagnitude(f).toFixed(1)}`);
      const mapF = (x,y) => [x, chainY(fl, x, y)];
      ink = remapGray(ink0, bw, bh, mapF);
      inkF = focus ? remapGray(inkF0, bw, bh, mapF) : ink;
      g = remapGray(g0, bw, bh, mapF);
      if(fieldMagnitude(f) < 0.6) break;
    }
    return {fl, g, ink, inkF};
  };
  if(dewarp){
    let g0 = grayBox(), ink0 = inkOf(g0, bw, bh);
    let r = runFields(g0, ink0);
    if(r.fl.length){
      pitch = r.fl[r.fl.length-1].pitch;
      // kapak/başlık sayfası gibi az satırlı sayfalarda (iri harf, süs) hizasızlık yan sayfa sanılmasın
      const nMeas = r.fl[r.fl.length-1].nMeas || 0;
      const nc = (focus || nMeas < 200) ? {x0:0, x1:bw} : findNeighborCut(r.ink, r.g, bw, bh, pitch);
      if(nc.x0 > 0 || nc.x1 < bw){
        dbg.push(`${tag} yan sayfa ${nc.x0|0}-${nc.x1|0}/${bw}${G.__cutDbg || ""}`);
        if(nc.x0 > 0) neighborSide[3] = true;
        if(nc.x1 < bw) neighborSide[1] = true;
        box = {x0: box.x0 + nc.x0, y0: box.y0, x1: box.x0 + nc.x1, y1: box.y1};
        bw = box.x1 - box.x0;
        g0 = grayBox(); ink0 = inkOf(g0, bw, bh);
        r = runFields(g0, ink0);
      }
      fields = r.fl; inkD = r.ink; gD = r.g;
      if(fields.length){
        pitch = fields[fields.length-1].pitch;
        const m = estimateMargins(r.inkF || r.ink, bw, bh, pitch, null);
        if(!m || !m.L || m.L.inl <= 0.55 || m.L.n < 6) dbg.push(`${tag} kenar yok [${G.__mDbg||''}]`);
        if(m && m.L && m.L.inl > 0.55 && m.L.n >= 6){
          margins = m;
          tb = textBlockFrom(m, pitch, bw);
          dbg.push(`${tag} kenar L(b=${m.L.b.toFixed(3)}) R(b=${m.R?m.R.b.toFixed(3):'-'}) blok:${tb ? tb.n+' satır' : 'yok'}`);
        }
      }
    }
  }
  if(G.__keep){
    const dw = fields.length ? remapGray(grayBox(), bw, bh, (x,y)=>[x, chainY(fields,x,y)]) : grayBox();
    G.__keep.push({tag, rect, Wa, Ha, dw, ink: inkD, bw, bh});
  }
  const toSrc = (x, y) => {
    const yy = fields.length ? chainY(fields, x, y) : y;
    return applyH(hm, box.x0 + x, box.y0 + yy);
  };
  const srcH = (dist(quad[0],quad[3]) + dist(quad[1],quad[2]))/2;
  return {toSrc, bw, bh, fields, margins, tb, pitch, ink: inkD, gray: gD, srcPerPx: srcH/Ha, neighborSide, box, Wa, Ha};
}
/* düz satırlı görüntüde sol (ve uygunsa sağ) yazı kenarını dik yapan yatay eşleme */
function marginMap(P){
  const m = P.margins;
  if(!m || Math.abs(m.L.b) >= 0.3) return null;
  const yRef = P.bh/2;
  const Lr = m.L.a + m.L.b*yRef;
  const useR = m.R && m.R.inl > 0.6 && m.R.n >= 6 && Math.abs(m.R.b - m.L.b) < 0.2;
  const Rr = useR ? m.R.a + m.R.b*yRef : 0;
  return (x, y) => {
    const Ly = m.L.a + m.L.b*y;
    if(useR && Rr - Lr > P.bw*0.3){
      const Ry = m.R.a + m.R.b*y;
      return Ly + (x - Lr) * (Ry - Ly)/(Rr - Lr);
    }
    return x + (Ly - Lr);
  };
}
/* içerik kutusu (B düzleminin düz-satır koordinatlarında): yazı bloğu +
   üstte/altta yazı sütunu içinde kalan başlık, sayfa no, fotoğraf.
   Sütunun hemen yanında da mürekkep varsa (dantel, masa, yan sayfa) orada durulur. */
function contentBox(P, dbg){
  const tb = P.tb, ink = P.ink, w = P.bw, h = P.bh, pitch = P.pitch;
  const yMid = (tb.yTop + tb.yBot)/2;
  // marginMap sonrası sol/sağ kenar dik: blok sınırları orta yükseklikten
  const xL = Math.max(0, Math.min(tb.Lf(tb.yTop), tb.Lf(tb.yBot), tb.Lf(yMid)));
  const xR = Math.min(w-1, Math.max(tb.Rf(tb.yTop), tb.Rf(tb.yBot), tb.Rf(yMid)));
  const cwid = xR - xL;
  const side = Math.max(4, Math.round(cwid*0.07));
  const rowIn = new Float32Array(h), rowOut = new Float32Array(h);
  const xa = Math.round(xL), xb = Math.round(xR);
  for(let y=0;y<h;y++){
    const r=y*w; let si=0, so=0;
    for(let x=xa; x<=xb; x++) si += ink[r+x];
    for(let x=Math.max(0,xa-side); x<xa; x++) so += ink[r+x];
    for(let x=xb+1; x<=Math.min(w-1,xb+side); x++) so += ink[r+x];
    rowIn[y] = si/(xb-xa+1); rowOut[y] = so/(2*side);
  }
  const ri = smooth1(rowIn, 2), ro = smooth1(rowOut, Math.max(2, Math.round(pitch*0.5)));
  const thrIn = 0.012;
  // satır dokusu: yazıda mürekkep harf vuruşlarıyla sık sık açılıp kapanır; sayfa kenarı şeridi,
  // gölge bandı düz bir koyuluktur (oran ~0) → "yazı satırı" sayılmaz
  const rowTex = new Float32Array(h);
  for(let y=0;y<h;y++){ const r=y*w; let d=0, t=0; for(let x=xa; x<xb-2; x++){ d += Math.abs(ink[r+x+2]-ink[r+x]); t += ink[r+x]; } rowTex[y] = t > 1e-3 ? d/t : 0; }
  const rt = smooth1(rowTex, 2);
  const inkRow = y => ri[y] > thrIn && rt[y] >= 0.35;
  // blok satırlarındaki tipik yan-mürekkep (dar kenar boşluğunda yandaki zemin
  // zaten görünüyorsa o seviye "normal" sayılır)
  const blockRo = []; for(let y=Math.max(0,tb.yTop|0); y<Math.min(h,tb.yBot|0); y+=2) blockRo.push(ro[y]);
  const roBase = blockRo.length ? quantile(blockRo, 0.5) : 0;
  const bgT = Math.max(0.03, roBase*2.5 + 0.01);
  // satır başına sütun içi ortalama gri: boşluk satırları kağıt mı (bölüm başlığı ile
  // metin arasındaki büyük boşluk) yoksa sayfa dışı mı?
  const gr = P.gray, rowG = new Float32Array(h);
  if(gr) for(let y=0;y<h;y++){ let sg=0; const r=y*w; for(let x=xa; x<=xb; x+=2) sg += gr[r+x]; rowG[y] = sg/(((xb-xa)>>1)+1); }
  const paperG = gr ? quantile(Array.from(rowG.subarray(Math.max(0,tb.yTop|0), Math.min(h,tb.yBot|0))), 0.9) : 0;
  const extend = (from, step) => {
    let edge = from, gap = 0, hitBg = false;
    for(let y=from; y>=0 && y<h; y+=step){
      if(ro[y] > bgT){ hitBg = true; break; }            // yan boşluğa taşan mürekkep → sayfa dışı zemin
      if(gr && rowG[y] < paperG*0.55 && Math.abs(y - from) > pitch){ hitBg = true; break; }   // kağıt bitti
      if(inkRow(y)){ edge = y; gap = 0; continue; }
      gap++;
      const paperRow = gr && rowG[y] > paperG*0.85;      // boş ama kağıt
      if(gap > pitch*(paperRow ? 14 : 3.2)) break;
      if(gr && !paperRow && gap > pitch*1.5){ hitBg = true; break; }
    }
    return {edge, hitBg};
  };
  const up = extend(Math.round(tb.yTop), -1), dn = extend(Math.round(tb.yBot), 1);
  // sayfa numarası / küçük başlık: satır ortalaması eşiğinin altında kalır (1-3 rakam),
  // ama sütun içinde yoğun, kısa bir lekedir. Kağıt bitene dek (en çok ~16 satır) aranır.
  const smallMark = (from, step) => {
    const win = Math.max(6, Math.round(pitch*2.2));
    const xa2 = xa, xb2 = xb;
    const lim = Math.round(pitch*16);
    // her satırda süren dikey koyuluk (sırt gölgesi, sayfa kenarı) sayfa numarası değildir → o sütunlar sayılmaz
    const colHit = new Float32Array(w); let nRows = 0;
    for(let k=1, y=from.edge+step; k<lim && y>=0 && y<h; k++, y+=step){ nRows++; const r = y*w; for(let x=xa2; x<=xb2; x++) if(ink[r+x] > 0.3) colHit[x]++; }
    const streak = new Uint8Array(w);
    for(let x=xa2; x<=xb2; x++) if(nRows >= 4 && colHit[x] > nRows*0.5) streak[x] = 1;
    const rowMax = y => {
      let s = 0, best = 0; const r = y*w;
      for(let x=xa2; x<=xb2; x++){ if(!streak[x]) s += ink[r+x]; if(x - xa2 >= win && !streak[x-win]) s -= ink[r+x-win]; if(s > best) best = s; }
      return best;
    };
    let run0 = -1, run1 = -1, mass = 0, closed = false;
    for(let k=1, y=from.edge+step; k<lim && y>=0 && y<h; k++, y+=step){
      if(gr && rowG[y] < paperG*0.8) break;                // kağıt bitti (sayfa kenarı/gölge)
      if(ro[y] > bgT) break;
      const m = rowMax(y);
      if(m > pitch*0.05){ if(run0 < 0) run0 = y; run1 = y; mass += m; }
      else if(run0 >= 0 && Math.abs(y - run1) > pitch*0.5){ closed = true; break; }
    }
    // leke iki yanından kağıtla çevrili olmalı: kağıt bitene dek süren koyuluk sayfa kenarıdır
    if(run0 < 0 || !closed) return from.edge;
    const hgt = Math.abs(run1 - run0) + 1;
    if(hgt < pitch*0.25 || hgt > pitch*1.6 || mass < pitch*pitch*0.03) return from.edge;
    return run1;
  };
  const upE = smallMark(up, -1), dnE = smallMark(dn, 1);
  if(upE !== up.edge || dnE !== dn.edge) dbg.push(`küçük işaret: üst ${up.edge - upE} alt ${dnE - dn.edge} px`);
  const pad = Math.round(pitch*0.6), padX = Math.round(pitch*0.4);
  const y0 = Math.max(0, upE - pad), y1 = Math.min(h, dnE + pad);
  // satır sonları blok hizasının dışına taşabilir (içindekiler, sağa yaslanmamış satır,
  // kıvrımda dışa kayan uçlar): kağıt üzerinde ve gerçek bir boşluğa gelene dek genişlet.
  // Yan sayfa ya da zemin: kağıt olmayan sütun veya ~1 satır aralığından geniş boşluk.
  const colInk = x => { let sI = 0; for(let y=y0; y<y1; y+=2) sI += ink[y*w+x]; return sI; };
  const lineRow = new Uint8Array(h);
  // yazı satırı olan satırlar (blok sütununda dokulu mürekkep): her satır dahil (içindekiler gibi kısa satırlar da)
  for(let y=0;y<h;y++) if(inkRow(y)) for(let d=-1; d<=1; d++){ const yy = y+d; if(yy >= 0 && yy < h) lineRow[yy] = 1; }
  const gapShare = x => { let a = 0, g = 0; for(let y=Math.max(0, Math.round(tb.yTop)); y<Math.min(h, Math.round(tb.yBot)); y+=2){ const v = ink[y*w+x]; if(lineRow[y]) a += v; else g += v; } return a + g > 0 ? g/(a + g) : 0; };
  const colPaper = x => { if(!gr) return true; let sg = 0, n = 0; for(let y=y0; y<y1; y+=4){ sg += gr[y*w+x]; n++; } return n && sg/n > paperG*0.9; };
  const inkCol = Math.max(0.6, (y1-y0)/2*0.002);
  const extX = (from, step) => {
    let edge = from, gap = 0;
    for(let x = from + step; x >= 0 && x < w; x += step){
      if(!colPaper(x)) break;
      if(colInk(x) > inkCol){ if(gapShare(x) > 0.25) break; edge = x; gap = 0; }
      else if(++gap > pitch*1.1) break;
    }
    return edge;
  };
  // ~3 satır aralığından uzun "taşma" yazı değil, gölge/kenar demektir → yok say
  const capX = e => Math.abs(e) > pitch*3 ? 0 : e;
  const eR = Math.round(xR) + capX(extX(Math.round(xR), 1) - Math.round(xR));
  const eL = Math.round(xL) + capX(extX(Math.round(xL), -1) - Math.round(xL));
  let x0 = Math.max(0, Math.min(xL, eL) - padX), x1 = Math.min(w, Math.max(xR, eR) + padX);
  if(eR > xR + 2 || eL < xL - 2) dbg.push(`taşan satır: sol ${Math.round(xL - eL)} sağ ${Math.round(eR - xR)} px`);
  // kağıt sınırları: yazıdan (başlık, sayfa no dahil) DIŞA doğru yalnız temiz boş kağıt sürdükçe
  // genişlenir. İlk temiz olmayan satır/sütunda (sırt gölgesi, sayfa kenarı çizgisi, sıcak ışıkta
  // turuncu sayfa yığını, dantel, zemin) durulur → çıktıda "kitapta olmayan iz" kalmaz.
  let Y0 = y0, Y1 = y1;
  if(gr){
    const clean = paperG*0.88;
    const colMean = x => { let sg = 0, n = 0; for(let y=y0; y<y1; y+=4){ sg += gr[y*w+x]; n++; } return n ? sg/n : 0; };
    const cL = Math.max(0, Math.round(Math.min(xL, eL))), cR = Math.min(w-1, Math.round(Math.max(xR, eR)));
    // parça parça: eğik bir kenar şeridi satırın/sütunun yalnız bir kısmını kaplar, ortalamada kaybolur
    const NSEG = 8;
    const rowOk = y => {
      if(ri[y] > thrIn) return false;
      const r = y*w, span = Math.max(1, xb - xa + 1);
      for(let k=0;k<NSEG;k++){ const a = xa + Math.floor(span*k/NSEG), z = xa + Math.floor(span*(k+1)/NSEG); let sg = 0, n = 0; for(let x=a; x<z; x+=2){ sg += gr[r+x]; n++; } if(n && sg/n < clean) return false; }
      return true;
    };
    const colOk = x => {
      const span = Math.max(1, y1 - y0);
      for(let k=0;k<NSEG;k++){ const a = y0 + Math.floor(span*k/NSEG), z = y0 + Math.floor(span*(k+1)/NSEG); let sg = 0, n = 0; for(let y=a; y<z; y+=3){ sg += gr[y*w+x]; n++; } if(n && sg/n < clean) return false; }
      return colInk(x) <= inkCol;
    };
    // satır sonu taşması (satır bantlarına oturan mürekkep) yazıdır: içinden geçilir
    const colText = x => colInk(x) > inkCol && gapShare(x) <= 0.25 && colMean(x) >= paperG*0.62;
    let pyT = Math.max(0, Math.min(upE, up.edge)), pyB = Math.min(h-1, Math.max(dnE, dn.edge));
    while(pyT > 0 && rowOk(pyT-1)) pyT--;
    while(pyB < h-1 && rowOk(pyB+1)) pyB++;
    let pxL = cL, pxR = cR;
    while(pxL > 0 && (colOk(pxL-1) || colText(pxL-1))) pxL--;
    while(pxR < w-1 && (colOk(pxR+1) || colText(pxR+1))) pxR++;
    // büyüme yazı taşmasıyla bittiyse (kenarda yazı) son yazı sütununa kadar; temiz kağıtta bittiyse orası
    const nX0 = Math.max(x0, pxL), nX1 = Math.min(x1, pxR+1), nY0 = Math.max(Y0, pyT), nY1 = Math.min(Y1, pyB+1);
    if(nX0 !== x0 || nX1 !== x1 || nY0 !== Y0 || nY1 !== Y1) dbg.push(`kağıt sınırı: ${x0|0}-${x1|0}×${Y0}-${Y1} → ${nX0|0}-${nX1|0}×${nY0}-${nY1}`);
    x0 = nX0; x1 = nX1; Y0 = nY0; Y1 = nY1;
  }
  dbg.push(`içerik ${x0|0}-${x1|0} × ${Y0}-${Y1} (blok ${tb.yTop|0}-${tb.yBot|0})${up.hitBg?' üst:zemin':''}${dn.hitBg?' alt:zemin':''}`);
  return {x0, y0: Y0, w: x1-x0, h: Y1-Y0, pitch, cutTop: up.edge <= 2, cutBot: dn.edge >= h-3,
          extraTop: (tb.yTop - upE)/pitch, extraBot: (dnE - tb.yBot)/pitch};
}
function gridAt(grid, u, v){
  const gyf=v/grid.gs, gy=Math.min(grid.gh-2, gyf|0), fy=gyf-gy, gxf=u/grid.gs, gx=Math.min(grid.gw-2, gxf|0), fx=gxf-gx;
  const i00=gy*grid.gw+gx, i01=i00+grid.gw;
  return [
    (grid.mx[i00]*(1-fx)+grid.mx[i00+1]*fx)*(1-fy)+(grid.mx[i01]*(1-fx)+grid.mx[i01+1]*fx)*fy,
    (grid.my[i00]*(1-fx)+grid.my[i00+1]*fx)*(1-fy)+(grid.my[i01]*(1-fx)+grid.my[i01+1]*fx)*fy,
  ];
}
/* RGBA → Q×Q blok ortalamalı RGB (Float32, 3 kanal) */
function shrinkRGB(d, w, h, Q){
  const qw=Math.ceil(w/Q), qh=Math.ceil(h/Q);
  const o=new Float32Array(qw*qh*3), c=new Float32Array(qw*qh);
  for(let y=0;y<h;y++){
    const qrow=((y/Q)|0)*qw, row=y*w;
    for(let x=0;x<w;x++){
      const qi=qrow+((x/Q)|0), j=(row+x)*4, k=qi*3;
      o[k]+=d[j]; o[k+1]+=d[j+1]; o[k+2]+=d[j+2]; c[qi]++;
    }
  }
  for(let i=0;i<qw*qh;i++){ const n=c[i]||1; o[i*3]/=n; o[i*3+1]/=n; o[i*3+2]/=n; }
  return o;
}
/* yerel kağıt rengi: sayfa 6×8 hücreye bölünür; her hücrede en parlak %15'in
   ortalaması alınır, sonra komşular içinden en parlağı seçilir (parmağın
   kapladığı hücre kendi rengini "kağıt" sanmasın). Karışık ışıkta (bir yanı
   sarı lamba, öbür yanı gün ışığı) ten testi her bölgede kendi kağıdına göre yapılır. */
function localPaperGrid(q, qw, qh){
  const GX = 6, GY = 8, cw = qw/GX, ch = qh/GY;
  const cells = new Float32Array(GX*GY*4);          // r, g, b, L
  for(let cy=0; cy<GY; cy++) for(let cx=0; cx<GX; cx++){
    const x0=Math.floor(cx*cw), x1=Math.max(x0+1, Math.floor((cx+1)*cw));
    const y0=Math.floor(cy*ch), y1=Math.max(y0+1, Math.floor((cy+1)*ch));
    const ls=[];
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){ const j=(y*qw+x)*3; ls.push(0.299*q[j]+0.587*q[j+1]+0.114*q[j+2]); }
    const t = quantile(ls, 0.85);
    let r=0,g=0,b=0,n=0;
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
      const j=(y*qw+x)*3, l=0.299*q[j]+0.587*q[j+1]+0.114*q[j+2];
      if(l>=t){ r+=q[j]; g+=q[j+1]; b+=q[j+2]; n++; }
    }
    const k=(cy*GX+cx)*4; n=n||1;
    cells[k]=r/n; cells[k+1]=g/n; cells[k+2]=b/n; cells[k+3]=0.299*r/n+0.587*g/n+0.114*b/n;
  }
  const best = new Float32Array(cells.length);
  for(let cy=0; cy<GY; cy++) for(let cx=0; cx<GX; cx++){
    let bk=(cy*GX+cx)*4;
    for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
      const yy=cy+dy, xx=cx+dx;
      if(yy<0||yy>=GY||xx<0||xx>=GX) continue;
      const k=(yy*GX+xx)*4;
      // kendi hücresi kağıda yakınsa kendisi; değilse komşulardan en parlak
      if(cells[k+3] > cells[bk+3]*1.12) bk=k;
    }
    const o=(cy*GX+cx)*4;
    best[o]=cells[bk]; best[o+1]=cells[bk+1]; best[o+2]=cells[bk+2]; best[o+3]=cells[bk+3];
  }
  return (x, y) => {
    const fx=Math.max(0, Math.min(GX-1.001, x/cw-0.5)), fy=Math.max(0, Math.min(GY-1.001, y/ch-0.5));
    const x0=fx|0, y0=fy|0, tx=fx-x0, ty=fy-y0;
    const out=[0,0,0];
    for(let c=0;c<3;c++){
      const a=best[(y0*GX+x0)*4+c], b2=best[(y0*GX+x0+1)*4+c], c2=best[((y0+1)*GX+x0)*4+c], d=best[((y0+1)*GX+x0+1)*4+c];
      out[c]=(a*(1-tx)+b2*tx)*(1-ty)+(c2*(1-tx)+d*tx)*ty;
    }
    return out;
  };
}
function paperColorQ(q, n){
  const rs=[],gs=[],bs=[];
  for(let i=0;i<n;i++){ const j=i*3, l=0.299*q[j]+0.587*q[j+1]+0.114*q[j+2]; if(l>140){ rs.push(q[j]); gs.push(q[j+1]); bs.push(q[j+2]); } }
  if(rs.length < n*0.05) return [245,245,245];
  return [quantile(rs,0.6), quantile(gs,0.6), quantile(bs,0.6)];
}
/* düşük çözünürlüklü alfa haritasını çift doğrusal büyüterek doldur */
function fillAlphaQ(d, w, h, a, qw, qh, Q, col){
  for(let y=0;y<h;y++){
    const fy=Math.max(0, Math.min(qh-1.001, (y+0.5)/Q-0.5)), y0=fy|0, ty=fy-y0;
    for(let x=0;x<w;x++){
      const fx=Math.max(0, Math.min(qw-1.001, (x+0.5)/Q-0.5)), x0=fx|0, tx=fx-x0;
      const p=y0*qw+x0;
      const al=(a[p]*(1-tx)+a[p+1]*tx)*(1-ty)+(a[p+qw]*(1-tx)+a[p+qw+1]*tx)*ty;
      if(al<=0.01) continue;
      const j=(y*w+x)*4;
      d[j]=d[j]*(1-al)+col[0]*al; d[j+1]=d[j+1]*(1-al)+col[1]*al; d[j+2]=d[j+2]*(1-al)+col[2]*al;
    }
  }
}
/* yan sayfa: ana sayfanın satırları düzleştirildikten sonra, komşu sayfanın
   satırları ana sayfanınkilerle HİZALI OLMAZ. Dar şeritlerin satır profilleri
   merkez referansla pencere pencere karşılaştırılır; merkezden dışa doğru
   arka arkaya "hizasız yazı" şeritleri bulunursa, araya düşen en boş sütundan
   kesilir (kesim yalnızca gerçek bir boşlukta yapılır → ana sayfadan yazı
   asla kesilmez). */
function findNeighborCut(ink, g, w, h, pitch){
  const res = {x0:0, x1:w};
  G.__cutDbg = '';
  const P = pitch;
  const sw = Math.max(8, Math.round(P*1.2));
  const ns = Math.floor(w/sw);
  if(ns < 6) return res;
  const profs = [];
  for(let k=0;k<ns;k++){
    const x0=k*sw, x1=Math.min(w, x0+sw), p=new Float32Array(h);
    for(let y=0;y<h;y++){ let s=0; const r=y*w; for(let x=x0;x<x1;x++) s+=ink[r+x]; p[y]=s/(x1-x0); }
    profs.push(smooth1(p, 1));
  }
  const ka=Math.floor(ns*0.35), kb=Math.max(ka+1, Math.ceil(ns*0.65));
  const ref=new Float32Array(h);
  for(let k=ka;k<kb;k++) for(let y=0;y<h;y++) ref[y]+=profs[k][y]/(kb-ka);
  const hw=Math.max(6, Math.round(2*P)), st=Math.max(4, Math.round(P)), smax=Math.max(1, Math.round(0.15*P));
  const wins=[]; for(let yc=hw+smax; yc<h-hw-smax; yc+=st) wins.push(yc);
  if(wins.length < 4) return res;
  const en = (p, yc) => { let s=0,s2=0,n=0; for(let y=yc-hw;y<=yc+hw;y++){ s+=p[y]; s2+=p[y]*p[y]; n++; } const m=s/n; return s2/n-m*m; };
  const refE = wins.map(yc => en(ref, yc));
  const allE = []; profs.forEach(p => wins.forEach(yc => allE.push(en(p, yc))));
  const eT = quantile(allE, 0.7)*0.15;
  const rT = quantile(refE, 0.7)*0.15;
  const ncc = (a, b, yc, s) => {
    let sa=0,sb=0,n=0;
    for(let y=yc-hw;y<=yc+hw;y++){ sa+=a[y]; sb+=b[y+s]; n++; }
    const ma=sa/n, mb=sb/n; let num=0,ea=0,eb=0;
    for(let y=yc-hw;y<=yc+hw;y++){ const da=a[y]-ma, db=b[y+s]-mb; num+=da*db; ea+=da*da; eb+=db*db; }
    return ea>0&&eb>0 ? num/Math.sqrt(ea*eb) : 0;
  };
  // şeridin mürekkebi bu sayfanın satır bantlarına mı düşüyor? (içindekiler gibi seyrek satır
  // sonları aynı satırlardadır; komşu sayfanın satırları başka yüksekliklerdedir)
  const refThr = quantile(ref, 0.95)*0.35;
  const inLine = p => { let a = 0, t = 0; for(let y=0;y<h;y++){ t += p[y]; if(ref[y] > refThr) a += p[y]; } return t > 0 ? a/t : 0; };
  const frac = profs.map(p => {
    let n=0, good=0;
    wins.forEach((yc, wi) => {
      if(en(p, yc) < eT || refE[wi] < rT) return;
      n++;
      let b=-1; for(let s=-smax;s<=smax;s++) b=Math.max(b, ncc(ref, p, yc, s));
      if(b > 0.5) good++;
    });
    if(n < 3) return null;
    const f = good/n;
    return f < 0.45 && inLine(p) >= 0.8 ? 0.6 : f;
  });
  // sütun "yazı enerjisi" (kesim yeri için): düşeyde yumuşak değişen sırt
  // gölgesi elenir, yalnızca satır satır değişen gerçek yazı kalır
  const col=new Float32Array(w);
  {
    const r = Math.max(2, Math.round(P*0.6));
    for(let x=0;x<w;x++){
      let s=0, acc=0;
      const k=2*r+1;
      for(let y=-r;y<=r;y++) acc += ink[Math.min(h-1,Math.max(0,y))*w+x];
      for(let y=0;y<h;y++){
        s += Math.abs(ink[y*w+x] - acc/k);
        acc += ink[Math.min(h-1,y+r+1)*w+x] - ink[Math.max(0,y-r)*w+x];
      }
      col[x]=s;
    }
  }
  const cs=smooth1(col, Math.max(1, Math.round(P/6)));
  const textCol = quantile(cs.subarray((w*0.25)|0, (w*0.75)|0), 0.6);
  G.__cutDbg = ' frac=' + frac.map(f => f==null ? '-' : Math.min(9, f*10|0)).join('');
  // şerit yazı yoğunluğu: komşu sayfa da tam bir yazı sayfasıdır; içindekiler gibi seyrek satır sonları değil
  const dens = profs.map(p => { let s = 0; for(let y=0;y<h;y++) s += p[y]; return s/h; });
  let dC = 0; for(let k=ka;k<kb;k++) dC += dens[k]/(kb-ka);
  const scan = (from, to, step) => {
    let lastGood = -1, firstBad = -1, bad = 0;
    for(let k=from; step>0 ? k<to : k>to; k+=step){
      const f = frac[k];
      if(f == null) continue;
      if(f >= 0.45){ lastGood = k; firstBad = -1; bad = 0; }
      else if(f < 0.3){
        if(firstBad < 0) firstBad = k;
        bad++;
        if(bad >= 2) break;
      }
    }
    if(firstBad < 0 || lastGood < 0) return -1;
    { let sd = 0, n = 0; for(let k=firstBad; step>0 ? k<ns : k>=0; k+=step){ if(frac[k] != null){ sd += dens[k]; n++; } }
      if(!n || sd/n < dC*0.45) return -1; }        // ötesi seyrek: aynı sayfanın uzun satır sonları
    // dış tarafta yalnız 1 hizasız şerit varsa, ötesinde yazı olmamalı (dar komşu şerit)
    if(bad < 2){
      for(let k=firstBad+step; step>0 ? k<ns : k>=0; k+=step) if(frac[k] != null) return -1;
    }
    // en boş sütun: son iyi şerit ile ilk kötü şerit arasında
    const a = step>0 ? lastGood*sw + sw/2 : firstBad*sw + sw/2;
    const b = step>0 ? firstBad*sw + sw/2 : lastGood*sw + sw/2;
    let bx=-1, bv=1e9;
    for(let x=Math.max(0, a|0); x<Math.min(w, b|0); x++) if(cs[x] < bv){ bv=cs[x]; bx=x; }
    if(bx < 0 || bv > textCol*0.3) return -1;     // gerçek boşluk yok → kesme
    return bx;
  };
  const kc = ns>>1;
  const xr = scan(kc, ns, 1), xl = scan(kc, -1, -1);
  if(xr > 0) res.x1 = xr;
  if(xl > 0) res.x0 = xl;
  if(res.x1 - res.x0 < w*0.4) return {x0:0, x1:w};
  return res;
}
/* mürekkep istatistikleri (1/4 çözünürlükte): kenar bantlarındaki yazı,
   parmak/yazı çakışması, netlik */
function inkStatsQ(d, w, h, Q, box, fingerQ){
  const qw=Math.ceil(w/Q), qh=Math.ceil(h/Q);
  const q = shrinkRGB(d, w, h, Q);
  const L = new Float32Array(qw*qh);
  for(let i=0;i<qw*qh;i++) L[i]=0.299*q[i*3]+0.587*q[i*3+1]+0.114*q[i*3+2];
  const paper = quantile(L, 0.8);
  const thr = paper*0.86;
  const bx0=(box.x0/Q)|0, bx1=Math.ceil(box.x1/Q), by0=(box.y0/Q)|0, by1=Math.ceil(box.y1/Q);
  const band = Math.max(2, Math.round(Math.min(qw,qh)*0.03));
  const frac = (x0,x1,y0,y1) => { let c=0,t=0; for(let y=Math.max(0,y0);y<Math.min(qh,y1);y++) for(let x=Math.max(0,x0);x<Math.min(qw,x1);x++){ t++; if(L[y*qw+x]<thr) c++; } return t?c/t:0; };
  const edge = [frac(bx0,bx1,by0,by0+band), frac(bx1-band,bx1,by0,by1), frac(bx0,bx1,by1-band,by1), frac(bx0,bx0+band,by0,by1)];
  const all = frac(bx0,bx1,by0,by1);
  let fingerOnText = 0;
  if(fingerQ){
    // yazı bloğu sınırları; parmak bu blokla örtüşüyorsa metin kapanmıştır
    const colI=new Float32Array(qw), rowI=new Float32Array(qh);
    for(let y=0;y<qh;y++) for(let x=0;x<qw;x++){ const i=y*qw+x; if(!fingerQ[i] && L[i]<thr){ colI[x]++; rowI[y]++; } }
    const cq=quantile(colI,0.9)*0.2, rq=quantile(rowI,0.9)*0.2;
    let tx0=qw,tx1=0,ty0=qh,ty1=0;
    for(let x=0;x<qw;x++) if(colI[x]>cq){ if(x<tx0) tx0=x; tx1=x; }
    for(let y=0;y<qh;y++) if(rowI[y]>rq){ if(y<ty0) ty0=y; ty1=y; }
    let ov=0;
    for(let y=ty0;y<=ty1;y++) for(let x=tx0;x<=tx1;x++) if(fingerQ[y*qw+x]) ov++;
    fingerOnText = ov/(qw*qh);
  }
  // netlik: tam çözünürlükte seyrek gradyan örneklemesi
  let gs=0, gn=0, nDark=0, nVdark=0;
  const lum = i => 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
  for(let y=1;y<h-1;y+=4) for(let x=1;x<w-1;x+=4){
    const i=(y*w+x)*4;
    const m=Math.abs(lum(i+4)-lum(i-4))+Math.abs(lum(i+w*4)-lum(i-w*4));
    if(m>30){ gs+=m; gn++; }
    const l=lum(i); if(l<128){ nDark++; if(l<60) nVdark++; }
  }
  // crisp: koyu piksellerin ne kadarı gerçekten koyu (bulanık yazı griye döner)
  return {edge, frac: all, fingerOnText, sharp: gn ? gs/gn : 0, crisp: nDark >= 40 ? nVdark/nDark : -1};
}
/* tüm sayfalar TAM outW×outH; kırpma kutusu oranı korunarak ortalanır */
function toFinalPage(canvas, box, W, H){
  const w=box.x1-box.x0, h=box.y1-box.y0;
  const s=Math.min(W/w, H/h);
  const dw=Math.round(w*s), dh=Math.round(h*s);
  const d=ctx2d(canvas).getImageData(box.x0, box.y0, w, h).data;
  const rs=[],gs=[],bs=[];
  for(let x=0;x<w;x+=3) for(const y of [0,h-1]){ const i=(y*w+x)*4; rs.push(d[i]); gs.push(d[i+1]); bs.push(d[i+2]); }
  for(let y=0;y<h;y+=3) for(const x of [0,w-1]){ const i=(y*w+x)*4; rs.push(d[i]); gs.push(d[i+1]); bs.push(d[i+2]); }
  const c=mkCanvas(W,H), x2=ctx2d(c);
  x2.fillStyle=`rgb(${quantile(rs,0.5)|0},${quantile(gs,0.5)|0},${quantile(bs,0.5)|0})`;
  x2.fillRect(0,0,W,H);
  x2.imageSmoothingEnabled=true; x2.imageSmoothingQuality='high';
  x2.drawImage(canvas, box.x0, box.y0, w, h, (W-dw)>>1, (H-dh)>>1, dw, dh);
  return c;
}

/* ---------- Worker ---------- */
/* ---------- boş çıktı koruması ----------
   Ayrıntı ölçüsü: küçültülmüş gri görüntüde |piksel − 3×3 ortalaması| ortalaması.
   Yazı → yüksek, düz kağıt → ~0. Bölge oransal kutu (kaynakta merkez: kenardaki zemin sayılmasın). */
function detailStat(c, rx0, ry0, rx1, ry1){
  const sc = 240/Math.max(c.width, c.height);
  const w = Math.max(8, Math.round(c.width*sc)), h = Math.max(8, Math.round(c.height*sc));
  const d = imgData(downscale(c, w, h)).data;
  const g = new Float32Array(w*h); let a = 0;
  for(let i=0;i<w*h;i++){ g[i] = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2]; a += d[i*4+3]; }
  const x0 = Math.max(1, Math.floor(w*rx0)), x1 = Math.min(w-1, Math.ceil(w*rx1));
  const y0 = Math.max(1, Math.floor(h*ry0)), y1 = Math.min(h-1, Math.ceil(h*ry1));
  let s = 0, n = 0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const i = y*w + x;
    const m = (g[i-w-1]+g[i-w]+g[i-w+1]+g[i-1]+g[i]+g[i+1]+g[i+w-1]+g[i+w]+g[i+w+1])/9;
    s += Math.abs(g[i] - m); n++;
  }
  return {detail: n ? s/n : 0, alpha: a/(w*h)};
}
/* son çare: kaynağı olduğu gibi A4'e sığdır (boş sayfa vermektense ham görüntü) */
function plainPage(src, W, H){
  const c = mkCanvas(W, H), x = ctx2d(c);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  const s = Math.min(W/src.width, H/src.height);
  const dw = Math.round(src.width*s), dh = Math.round(src.height*s);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(downscale(src, dw, dh), (W-dw)>>1, (H-dh)>>1);
  return c;
}
const BLANK_SRC = 2.0, BLANK_OUT = 0.35;
async function handleProcess(m){
  const bmp = await createImageBitmap(m.blob);
  const c = mkCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  if(bmp.close) bmp.close();
  const src = detailStat(c, 0.2, 0.2, 0.8, 0.8);
  // bazı tarayıcılarda (iOS işçisi) tuval okunamayıp boş veri dönebiliyor → çağıran ana iş parçacığına düşer
  if(src.alpha < 8) throw new Error('kaynak görüntü okunamadı (boş tuval verisi)');
  let r = processCanvas(c, m.opts), guard = '';
  let o = detailStat(r.canvas, 0, 0, 1, 1);
  const o0 = o.detail;
  if(src.detail > BLANK_SRC && (o.detail < BLANK_OUT || o.alpha < 8)){
    // kaynakta yazı var ama çıktı boş: önce temizliksiz, o da boşsa ham sayfa
    const r2 = processCanvas(c, Object.assign({}, m.opts, {smartCrop:false}));
    o = detailStat(r2.canvas, 0, 0, 1, 1);
    if(o.detail >= BLANK_OUT && o.alpha >= 8){ r = r2; guard = 'boş çıktı → temizliksiz'; }
    else { r = {canvas: plainPage(c, m.opts.outW || 1240, m.opts.outH || 1754), issues: r.issues, metrics: r.metrics, dbg: r.dbg}; guard = 'boş çıktı → ham sayfa'; }
  }
  r.dbg = (r.dbg || '') + ` | ayrıntı kaynak:${src.detail.toFixed(2)} çıktı:${o0.toFixed(2)}` + (guard ? ' | ⚠ ' + guard : '');
  const out = rotateCanvas(r.canvas, m.opts.rot||0);
  const blob = await canvasToBlob(out, 'image/jpeg', m.opts.quality || 0.85);
  // PDF yalnız JPEG gömer; tarayıcı başka biçim verdiyse (ör. PNG) çağıran ana iş parçacığında yeniden dener
  if(!blob || (blob.type && blob.type !== 'image/jpeg')) throw new Error('JPEG üretilemedi: ' + (blob && blob.type));
  const tw = 240, th = Math.round(out.height*tw/out.width);
  const t = mkCanvas(tw, th), tx = t.getContext('2d');
  tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = 'high';
  tx.drawImage(downscale(out, tw*2, th*2), 0, 0, tw, th);
  const thumb = await canvasToBlob(t, 'image/jpeg', 0.75);
  return {blob, thumb, w:out.width, h:out.height, issues:r.issues, metrics:r.metrics, dbg:r.dbg, lineSig:r.lineSig || null, guard};
}
/* hızlı kontrol: m.bitmap (ImageBitmap) ya da m.blob */
async function handleQuick(m){
  let c = m.canvas || null;
  if(!c && m.buf){ c = mkCanvas(m.w, m.h); ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0); }
  if(!c){
    const bmp = m.bitmap || await createImageBitmap(m.blob);
    c = mkCanvas(bmp.width, bmp.height);
    ctx2d(c).drawImage(bmp, 0, 0);
    if(bmp.close) bmp.close();
  }
  // işçide tuval okunamıyorsa (boş veri) çağıran ana iş parçacığına geçer
  if(detailStat(c, 0.2, 0.2, 0.8, 0.8).alpha < 8) throw new Error('kaynak görüntü okunamadı (boş tuval verisi)');
  const r = processCanvas(c, Object.assign({}, m.opts, {quick:true}));
  return {issues: r.issues, metrics: r.metrics, dbg: r.dbg, lineSig: r.lineSig || null};
}
if(IN_WORKER){
  self.onmessage = async e => {
    const m = e.data;
    try{
      if(m.kind === 'quick'){ self.postMessage(Object.assign({id:m.id, ok:true}, await handleQuick(m))); return; }
      const r = await handleProcess(m);
      self.postMessage(Object.assign({id:m.id, ok:true}, r));
    }catch(err){
      self.postMessage({id:m.id, ok:false, error: String(err && err.stack || err)});
    }
  };
}

G.ScanCore = {
  mkCanvas, ctx2d, canvasToBlob, downscale, grayOf, toGray, mean, lapVar, quantile,
  detectPage, detectPageData, pageSignature, sigDiff, processCanvas, handleProcess, handleQuick, lineMatch,
  rotateCanvas, estimateTextField, estimateAspect, homography, applyH, inQuad,
};
})(typeof self !== 'undefined' ? self : this);
