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
  const smp = new Float32Array(Math.ceil(w*h/7)); for(let i=0, k=0; i<w*h; i+=7, k++) smp[k] = bg[i];
  const medBg = quantile(smp, 0.6);
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
  // Profil her satırda AYNI aralıkta (sütunun sol-sağ kenarı) alınır: satırın kendi ucu yanlış bulunsa da
  // (sırt üzerinden komşu sayfaya taşan iz, eksik izlenen uç) imza değişmez. Sütun bilinmiyorsa satırın kendi uçları.
  const col = !G.__lsOld && isFinite(m.xa) && isFinite(m.xb) && m.xb - m.xa > pitch*6 ? [Math.max(0, m.xa), Math.min(w-1, m.xb)] : null;
  for(const b of m.bands){
    if(b.ym < tb.yTop || b.ym > tb.yBot) continue;
    const r0 = Math.max(0, b.l), r1 = Math.min(w-1, b.r);
    if(Math.min(r1, col ? col[1] : r1) - Math.max(r0, col ? col[0] : r0) < pitch*3) continue;
    const x0 = col ? col[0] : r0, x1 = col ? col[1] : r1;
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
/* iki satır profilinin benzerliği (0..1). Profil 4 parçaya bölünür, her parça kendi küçük kaymasıyla (±3 kutu)
   eşleştirilir: kıvrık sayfada satırın farklı yerleri iki çekimde farklı miktarda esner; tek bir kayma buna yetmez. */
const LS_SEG = 4, LS_SH = 3;
function lineCorr(a, b){
  const L = LS_NB/LS_SEG; let tot = 0, wsum = 0;
  for(let s=0; s<LS_SEG; s++){
    const k0 = s*L, k1 = k0 + L;
    let ea = 0; for(let k=k0;k<k1;k++) ea += a[k]*a[k];
    if(ea < 1e-6) continue;
    let best = -1;
    for(let d=-LS_SH; d<=LS_SH; d++){
      let c = 0, eb = 0, e2 = 0;
      for(let k=k0;k<k1;k++){ const j = k - d; if(j < 0 || j >= LS_NB) continue; const x = a[k], y = b[j]; c += x*y; eb += y*y; e2 += x*x; }
      const v = c/Math.sqrt(Math.max(1e-9, e2*eb)); if(v > best) best = v;
    }
    tot += best*ea; wsum += ea;
  }
  return wsum > 0 ? tot/wsum : 0;
}
/* iki sayfanın satır imzaları: eşleşen satır oranı (0..1). Satırlar aynı sırayla ve
   tutarlı bir satır kaymasıyla eşleşmeli. */
function lineMatch(A, B){
  if(!A || !B || A.length < 3 || B.length < 3) return 0;
  const votes = new Map(), best = [];
  for(let i=0;i<A.length;i++){
    let bv = 0, bj = -1;
    for(let j=0;j<B.length;j++){ const v = lineCorr(A[i], B[j]); if(v > bv){ bv = v; bj = j; } }
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
/* ==TX-BEGIN== */
/* ============================================================
   YAZI ÖNCELİKLİ GEOMETRİ
   Sayfa kenarı aramak yerine doğrudan yazı satırları izlenir:
   yön (0-360°) → satır izleri → ana yazı bloğu (kenar hizaları) →
   yazı düzlemi (perspektif) → satır izlerinden kıvrım düzeltme.
   Dantel, klavye, yan sayfa, parmak, eğik/yan tutulmuş telefon fark etmez.
   ============================================================ */
/* satır yönü: mürekkep dairesel karolara bölünür, her açı için izdüşüm profilinin keskinliği
   ölçülür. Yazıda doğru açıda profil satır-boşluk-satır diye keskin ve PERİYODİK dalgalanır;
   dantel/zemin her açıda aynıdır, tek bir kenar çizgisi periyodik değildir → oy vermez.
   Karoların açıları kadraj boyunca değişiyorsa (perspektif: satırlar bir kaçış noktasına
   yönelir) eğim alanı m = A + B·y olarak verilir.
   Dönen: {ang (-π/2..π/2], A, B (döndürülmüş, merkezli koordinatlarda), pitch, cx, cy, nt} */
function txOrient(ink, w, h, hint){
  const TS = Math.max(40, Math.round(Math.min(w, h)/4.5));
  const R = TS/2, R2 = R*R, area = Math.PI*R2;
  const nx = Math.max(1, Math.round(w/(TS*0.7))), ny = Math.max(1, Math.round(h/(TS*0.7)));
  const NB = 2*Math.ceil(R) + 4;
  const hist = new Float32Array(NB);
  const tiles = [], cap = Math.ceil(area) + 8;
  for(let ty=0; ty<ny; ty++) for(let tx=0; tx<nx; tx++){
    const cx = R + (w - 2*R)*(nx > 1 ? tx/(nx-1) : 0.5), cy = R + (h - 2*R)*(ny > 1 ? ty/(ny-1) : 0.5);
    const px = new Float32Array(cap), py = new Float32Array(cap), pv = new Float32Array(cap); let n = 0, tot = 0;
    const x0 = Math.max(0, Math.floor(cx-R)), x1 = Math.min(w-1, Math.ceil(cx+R));
    const y0 = Math.max(0, Math.floor(cy-R)), y1 = Math.min(h-1, Math.ceil(cy+R));
    for(let y=y0; y<=y1; y++){ const dy = y-cy, r = y*w; for(let x=x0; x<=x1; x++){ const v = ink[r+x]; if(v < 0.15) continue; const dx = x-cx; if(dx*dx+dy*dy > R2 || n >= cap) continue; px[n] = dx; py[n] = dy; pv[n] = v; n++; tot += v; } }
    if(tot < area*0.012 || tot > area*0.5) continue;
    const cw = 1 - 0.5*Math.min(1, Math.hypot((cx - w/2)/(w/2), (cy - h/2)/(h/2)));
    tiles.push({px, py, pv, n, tot, cw, cx, cy});
  }
  if(tiles.length < 2){ G.__orWhy = 'karo ' + tiles.length; return null; }
  const fill = (t, c, s) => { hist.fill(0); const {px, py, pv, n} = t, o = R + 2; for(let k=0;k<n;k++) hist[(py[k]*c - px[k]*s + o)|0] += pv[k]; };
  const score = (t, th) => {
    fill(t, Math.cos(th), Math.sin(th));
    let e = 0; for(let i=2;i<NB;i++){ const d = hist[i]-hist[i-2]; e += d*d; }
    return e*NB/(t.tot*t.tot);
  };
  // aday açılar: tam tarama (4° adım) ya da önceki karenin açısı çevresi (±12°, 3° adım)
  const D2R = Math.PI/180, cand = [];
  if(hint != null) for(let k=-4;k<=4;k++) cand.push(hint + k*3*D2R);
  else for(let a=0;a<45;a++) cand.push(a*4*D2R);
  const NC = cand.length, maxLag = Math.floor(2*R/2.5);
  const tt = [];
  for(const t of tiles){
    const sc = new Float32Array(NC);
    for(let a=0;a<NC;a++) sc[a] = score(t, cand[a]);
    const med = hint != null ? Math.min(...sc) : quantile(sc, 0.5);
    let bi = 0; for(let a=1;a<NC;a++) if(sc[a] > sc[bi]) bi = a;
    const ex = sc[bi] - med;
    if(ex < 0.15 || ex < med*1.2) continue;
    // ince açı: ±3°, 0.5° adım
    const F = 13, fs = new Float32Array(F);
    for(let k=0;k<F;k++) fs[k] = score(t, cand[bi] + (k-6)*0.5*D2R);
    let fk = 0; for(let k=1;k<F;k++) if(fs[k] > fs[fk]) fk = k;
    let off = fk - 6;
    if(fk > 0 && fk < F-1){ const den = fs[fk-1] - 2*fs[fk] + fs[fk+1]; if(den < 0) off += 0.5*(fs[fk-1] - fs[fk+1])/den; }
    t.th = cand[bi] + off*0.5*D2R;
    // periyodiklik: doğru açıdaki profilin özilişkisi
    fill(t, Math.cos(t.th), Math.sin(t.th));
    const sm = smooth1(hist, Math.max(3, Math.round(R/3)));
    const d = new Float32Array(NB); let e0 = 0;
    for(let i=0;i<NB;i++){ d[i] = hist[i] - sm[i]; e0 += d[i]*d[i]; }
    if(e0 <= 0) continue;
    const ac = new Float32Array(maxLag+2);
    for(let l=2; l<=maxLag+1; l++){ let q = 0; for(let i=0;i+l<NB;i++) q += d[i]*d[i+l]; ac[l] = q/e0*NB/(NB-l); }
    let first = 0;
    for(let l=4; l<=maxLag; l++){
      if(ac[l] > 0.25 && ac[l] >= ac[l-1] && ac[l] > ac[l+1]){
        let mn = 1; for(let j=2;j<l;j++) if(ac[j] < mn) mn = ac[j];
        if(ac[l] - mn > 0.4){ first = l; break; }
      }
    }
    if(!first) continue;
    const den = ac[first-1] - 2*ac[first] + ac[first+1];
    t.pitch = first + (den < 0 ? 0.5*(ac[first-1] - ac[first+1])/den : 0);
    t.ex = ex;
    tt.push(t);
  }
  if(tt.length < 2){ G.__orWhy = `yazı karosu ${tt.length}/${tiles.length}`; return null; }
  // genel açı: yazı karolarının oyları (3° kutu, ±9° düzgünleştirme)
  const NA = 60, STEP = Math.PI/NA;
  const S = new Float64Array(NA);
  for(const t of tt){ const a = ((Math.round(t.th/STEP) % NA) + NA) % NA; S[a] += t.cw; }
  let bi = 0, bv = -1;
  for(let a=0;a<NA;a++){ let v = 0; for(let j=-3;j<=3;j++) v += S[(a+j+NA)%NA]*(4 - Math.abs(j)); if(v > bv){ bv = v; bi = a; } }
  const dAng = (a, b) => { let d = a - b; while(d > Math.PI/2) d -= Math.PI; while(d <= -Math.PI/2) d += Math.PI; return d; };
  const a0 = bi*STEP;
  let use = tt.filter(t => Math.abs(dAng(t.th, a0)) < 25*Math.PI/180);
  if(use.length < 2){ G.__orWhy = 'açı uyuşmuyor'; return null; }
  let sw = 0, sd = 0; for(const t of use){ sw += t.cw; sd += t.cw*dAng(t.th, a0); }
  let ang = a0 + sd/sw;
  while(ang > Math.PI/2) ang -= Math.PI; while(ang <= -Math.PI/2) ang += Math.PI;
  // eğim alanı (döndürülmüş, merkezli koordinat): m = A + B·y
  const c = Math.cos(ang), s = Math.sin(ang);
  let mx = 0, my = 0; for(const t of use){ mx += t.cw*t.cx; my += t.cw*t.cy; } mx /= sw; my /= sw;
  const pts = use.map(t => ({y: -s*(t.cx - mx) + c*(t.cy - my), m: Math.tan(dAng(t.th, ang)), w: t.cw}));
  let A = 0, B = 0;
  if(pts.length >= 5){
    let keep = pts.map(() => true);
    for(let it=0; it<3; it++){
      let n=0, sy=0, sm=0, syy=0, sym=0;
      pts.forEach((q, i) => { if(!keep[i]) return; n += q.w; sy += q.w*q.y; sm += q.w*q.m; syy += q.w*q.y*q.y; sym += q.w*q.y*q.m; });
      const den = n*syy - sy*sy;
      if(Math.abs(den) < 1e-9) break;
      B = (n*sym - sy*sm)/den; A = (sm - B*sy)/n;
      const res = pts.map(q => Math.abs(q.m - (A + B*q.y)));
      const lim = Math.max(0.03, quantile(res, 0.5)*3);
      keep = res.map(v => v <= lim);
    }
    let ymin = 1e9, ymax = -1e9; for(const q of pts){ if(q.y < ymin) ymin = q.y; if(q.y > ymax) ymax = q.y; }
    if(Math.abs(B)*(ymax - ymin) < 0.05){ A = 0; B = 0; }            // < ~3° yayılma: paralel say
  }
  const pitch = quantile(use.map(t => t.pitch), 0.5);
  return {ang, A, B, cx: mx, cy: my, pitch, nt: use.length, nTiles: tiles.length, hinted: hint != null};
}

/* 3×3 yardımcıları */
function m3mul(A, B){ const o = new Float64Array(9); for(let i=0;i<3;i++) for(let j=0;j<3;j++) o[i*3+j] = A[i*3]*B[j] + A[i*3+1]*B[3+j] + A[i*3+2]*B[6+j]; return o; }
function m3inv(m){
  const a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],i=m[8];
  const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g, det=a*A+b*B+c*C;
  return Float64Array.from([A, -(b*i-c*h), b*f-c*e, B, a*i-c*g, -(a*f-c*d), C, -(a*h-b*g), a*e-b*d].map(v => v/det));
}
function m3ap(m, x, y){ const w = m[6]*x + m[7]*y + m[8]; return [(m[0]*x + m[1]*y + m[2])/w, (m[3]*x + m[4]*y + m[5])/w]; }
/* kaynağı küçültüp satırlar yatay ve paralel olacak biçimde çarpıtır (dönme + satır kaçış noktası).
   or: {ang, A, B, cx, cy} — cx,cy ve B ölçeği s0 çalışma ölçeğinde. Dönen: {g, valid, w, h, toSrc, fromSrc, sc} */
function txWarp(src, or, s0, maxSide){
  const W = src.width, H = src.height;
  const sc = Math.min(1, maxSide/Math.max(W, H));
  const sw = Math.max(1, Math.round(W*sc)), sh = Math.max(1, Math.round(H*sc));
  const small = sc < 1 ? downscale(src, sw, sh) : src;
  const gs = toGray(imgData(small));
  const k = sc/s0;                                   // yön ölçeği → bu ölçek
  const c = Math.cos(or.ang), s = Math.sin(or.ang), cx = or.cx*k, cy = or.cy*k;
  // merkezle + döndür
  const Rm = Float64Array.from([c, s, -(c*cx + s*cy), -s, c, (s*cx - c*cy), 0, 0, 1]);
  const cor0 = [[0,0],[sw,0],[sw,sh],[0,sh]].map(([x,y]) => m3ap(Rm, x, y));
  let B = or.B/k; const A = or.A;
  const xmax = Math.max(...cor0.map(q => Math.abs(q[0])));
  const Bmax = 0.42/Math.max(1, xmax); if(Math.abs(B) > Bmax) B = Math.sign(B)*Bmax;
  const Hp = Float64Array.from([1, 0, 0, -A, 1, 0, B, 0, 1]);
  let M = m3mul(Hp, Rm);
  const cor = [[0,0],[sw,0],[sw,sh],[0,sh]].map(([x,y]) => m3ap(M, x, y));
  const minx = Math.min(...cor.map(q => q[0])), maxx = Math.max(...cor.map(q => q[0]));
  const miny = Math.min(...cor.map(q => q[1])), maxy = Math.max(...cor.map(q => q[1]));
  const z = Math.min(1, maxSide*1.4/Math.max(maxx - minx, maxy - miny));
  M = m3mul(Float64Array.from([z, 0, -minx*z, 0, z, -miny*z, 0, 0, 1]), M);
  const w = Math.max(8, Math.ceil((maxx - minx)*z)), h = Math.max(8, Math.ceil((maxy - miny)*z));
  const Mi = m3inv(M);
  const grid = buildGrid(w, h, 8, (u, v) => m3ap(Mi, u, v));
  const g = new Float32Array(w*h), valid = new Uint8Array(w*h);
  const {gw, gs: GS, mx, my} = grid;
  for(let v=0; v<h; v++){
    const gyf = v/GS, gy = gyf|0, fy = gyf-gy;
    for(let u=0; u<w; u++){
      const gxf = u/GS, gx = gxf|0, fx = gxf-gx, i00 = gy*gw+gx, i01 = i00+gw;
      const a0=(1-fx)*(1-fy), a1=fx*(1-fy), a2=(1-fx)*fy, a3=fx*fy;
      const x = mx[i00]*a0 + mx[i00+1]*a1 + mx[i01]*a2 + mx[i01+1]*a3;
      const y = my[i00]*a0 + my[i00+1]*a1 + my[i01]*a2 + my[i01+1]*a3;
      if(x < 0 || y < 0 || x > sw-1.001 || y > sh-1.001) continue;
      const xi = x|0, yi = y|0, tx = x-xi, ty = y-yi, q = yi*sw+xi;
      g[v*w+u] = (gs[q]*(1-tx) + gs[q+1]*tx)*(1-ty) + (gs[q+sw]*(1-tx) + gs[q+sw+1]*tx)*ty;
      valid[v*w+u] = 1;
    }
  }
  const fx = sw/W, fy = sh/H;
  const toSrc = (xr, yr) => { const q = m3ap(Mi, xr, yr); return [q[0]/fx, q[1]/fy]; };
  const fromSrc = (X, Y) => m3ap(M, X*fx, Y*fy);
  return {g, valid, w, h, toSrc, fromSrc, sc: sc*z, small, sw, sh};
}
/* geçersiz (kadraj dışı) pikselleri yok sayan mürekkep haritası */
function txInk(g, valid, w, h){
  // kadraj dışını en yakın geçerli satır değeriyle doldur (yapay kenar oluşmasın)
  const gg = new Float32Array(g);
  for(let y=0;y<h;y++){
    const r = y*w; let first = -1, last = -1;
    for(let x=0;x<w;x++) if(valid[r+x]){ if(first < 0) first = x; last = x; }
    if(first < 0) continue;
    for(let x=0;x<first;x++) gg[r+x] = gg[r+first];
    for(let x=last+1;x<w;x++) gg[r+x] = gg[r+last];
  }
  { // hiç geçerli pikseli olmayan satırlar: en yakın dolu satırdan
    const has = new Uint8Array(h); let first = -1, last = -1;
    for(let y=0;y<h;y++){ const r = y*w; for(let x=0;x<w;x+=4) if(valid[r+x]){ has[y] = 1; break; } if(has[y]){ if(first < 0) first = y; last = y; } }
    if(first >= 0){
      for(let y=0;y<first;y++) gg.copyWithin(y*w, first*w, first*w + w);
      for(let y=last+1;y<h;y++) gg.copyWithin(y*w, last*w, last*w + w);
    }
  }
  const ink = inkOf(gg, w, h);
  // geçersiz ve kenarına 2 px
  for(let y=0;y<h;y++){ const r = y*w; for(let x=0;x<w;x++){
    if(!valid[r+x] || (x > 1 && !valid[r+x-2]) || (x < w-2 && !valid[r+x+2]) || (y > 1 && !valid[r+x-2*w]) || (y < h-2 && !valid[r+x+2*w])) ink[r+x] = 0;
  } }
  return {ink, gray: gg};
}
/* satır izleri: mürekkep yatayda bulanıklaştırılır (kelimeler birleşir), her örnek sütunda
   düşey tepe noktaları (satır ortaları) bulunur ve soldan sağa zincirlenir.
   Dönen zincirler: {k0, ys[], x0, x1, amp, yAt(x), slope} */
function txTrace(ink, w, h, p){
  const rx = Math.max(2, Math.round(p*0.7)), ry = Math.max(1, Math.round(p*0.1));
  // yatay kutu ×2, düşey kutu ×1
  let S = new Float32Array(w*h), T = new Float32Array(w*h);
  const hblur = (a, b) => { const k = 2*rx+1; for(let y=0;y<h;y++){ const r = y*w; let s = 0; for(let x=-rx;x<=rx;x++) s += a[r + Math.min(w-1, Math.max(0, x))]; for(let x=0;x<w;x++){ b[r+x] = s/k; s += a[r + Math.min(w-1, x+rx+1)] - a[r + Math.max(0, x-rx)]; } } };
  hblur(ink, T); hblur(T, S);
  { const k = 2*ry+1; for(let x=0;x<w;x++){ let s = 0; for(let y=-ry;y<=ry;y++) s += S[Math.min(h-1, Math.max(0, y))*w+x]; for(let y=0;y<h;y++){ T[y*w+x] = s/k; s += S[Math.min(h-1, y+ry+1)*w+x] - S[Math.max(0, y-ry)*w+x]; } } }
  S = T;
  const dx = Math.max(2, Math.round(p/4)), nc = Math.floor((w - 1)/dx) + 1;
  const vr = Math.max(2, Math.round(p*0.8));
  // tepe noktaları
  const cols = [];
  const allV = [];
  for(let k=0;k<nc;k++){
    const x = Math.min(w-1, k*dx), pk = [];
    for(let y=1;y<h-1;y++){
      const v = S[y*w+x];
      if(v < 0.02 || v <= S[(y-1)*w+x] || v < S[(y+1)*w+x]) continue;
      let va = v, vb = v;
      for(let j=1;j<=vr;j++){ const a = y-j >= 0 ? S[(y-j)*w+x] : 0, b = y+j < h ? S[(y+j)*w+x] : 0; if(a < va) va = a; if(b < vb) vb = b; }
      const con = (v - Math.max(va, vb))/v;
      if(con < 0.3) continue;
      const a = S[(y-1)*w+x], b = S[(y+1)*w+x], den = a - 2*v + b;
      pk.push({y: y + (den < 0 ? 0.5*(a - b)/den : 0), v, con, used: false});
      allV.push(v);
    }
    cols.push(pk);
  }
  if(allV.length < 20) return {chains: [], S, dx};
  const vRef = quantile(allV, 0.6), vMin = vRef*0.22;
  // zincirle
  const tol = p*0.3, maxMiss = Math.max(2, Math.round(p*1.0/dx));
  let active = [];
  const done = [];
  for(let k=0;k<nc;k++){
    const pk = cols[k].filter(q => q.v >= vMin);
    const next = [];
    for(const ch of active){
      const n = ch.ys.length, miss = k - ch.k1;
      // eğim: son ~6 noktadan
      let sl = 0; { const m = Math.min(6, n-1); if(m >= 2) sl = (ch.ys[n-1] - ch.ys[n-1-m])/(m); }
      const pred = ch.ys[n-1] + sl*miss;
      let bq = null, bd = tol*(1 + 0.15*(miss-1));
      for(const q of pk){ if(q.used) continue; const d = Math.abs(q.y - pred); if(d < bd){ bd = d; bq = q; } }
      if(bq){
        bq.used = true;
        for(let j=1;j<miss;j++) ch.ys.push(ch.ys[n-1] + (bq.y - ch.ys[n-1])*j/miss);
        ch.ys.push(bq.y); ch.k1 = k; ch.sumV += bq.v; ch.nV++;
        next.push(ch);
      } else if(miss < maxMiss) next.push(ch);
      else done.push(ch);
    }
    for(const q of pk) if(!q.used){ q.used = true; next.push({k0: k, k1: k, ys: [q.y], sumV: q.v, nV: 1}); }
    active = next;
  }
  for(const ch of active) done.push(ch);
  const chains = [];
  for(const ch of done){
    const n = ch.ys.length;
    if(n < 5 || (n-1)*dx < p*2.2) continue;
    // düzgünleştir (±2 örnek)
    const ys = new Float32Array(n);
    for(let i=0;i<n;i++){ let s = 0, c = 0; for(let j=-2;j<=2;j++){ const q = i+j; if(q >= 0 && q < n){ s += ch.ys[q]; c++; } } ys[i] = s/c; }
    const c = {k0: ch.k0, n, ys, dx, amp: ch.sumV/ch.nV};
    c.xa = ch.k0*dx; c.xb = (ch.k0 + n - 1)*dx;
    // doğrusal uyum
    { let sx=0, sy=0, sxx=0, sxy=0; for(let i=0;i<n;i++){ const x = c.xa + i*dx; sx += x; sy += ys[i]; sxx += x*x; sxy += x*ys[i]; }
      const den = n*sxx - sx*sx; c.slope = den ? (n*sxy - sx*sy)/den : 0; c.icpt = (sy - c.slope*sx)/n; }
    c.yAt = x => {
      const f = (x - c.xa)/dx;
      if(f <= 0){ const m = Math.min(6, n-1); const sl = (ys[m] - ys[0])/(m*dx); return ys[0] + sl*(x - c.xa); }
      if(f >= n-1){ const m = Math.min(6, n-1); const sl = (ys[n-1] - ys[n-1-m])/(m*dx); return ys[n-1] + sl*(x - c.xb); }
      const i = f|0, t = f - i; return ys[i]*(1-t) + ys[i+1]*t;
    };
    chains.push(c);
  }
  // uçlar: bulanık olmayan mürekkepte, iz boyunca yazıya benzeyen mürekkebin bittiği yer
  for(const c of chains){
    const e = txEnds(ink, w, h, p, c, (c.xa + c.xb)/2, c.xa - p*3, c.xb + p*3);
    c.x0 = Math.min(e[0], c.xa + p); c.x1 = Math.max(e[1], c.xb - p);
    if(c.x0 > c.x1){ c.x0 = c.xa; c.x1 = c.xb; }
  }
  return {chains: chains.filter(c => c.x1 - c.x0 >= p*1.5), S, dx};
}
/* satır uçları: iz boyunca, ortadan dışa doğru yazıya benzeyen mürekkebin bittiği sütun.
   Yazı sütunu: satır bandında (±0.3p) mürekkep var, satır ARASINDA (±0.42-0.58p) yok. Sırt gölgesi,
   sayfa kenarı çizgisi gibi düşey izler satır arasını da doldurur → yazı sayılmaz, satır oraya uzamaz. */
function txEnds(ink, w, h, p, c, xm, xlo, xhi){
  const band = Math.max(1, Math.round(p*0.3)), o0 = Math.max(band+1, Math.round(p*0.42)), o1 = Math.max(o0+1, Math.round(p*0.58));
  const gapMax = Math.max(3, Math.round(p*1.3)), thr = Math.max(0.6, band*0.25), no = 2*(o1 - o0 + 1), nb = 2*band + 1;
  const isText = x => {
    const yc = Math.round(c.yAt(x)); let b = 0, o = 0;
    for(let d=-band; d<=band; d++){ const y = yc+d; if(y >= 0 && y < h) b += ink[y*w+x]; }
    if(b <= thr) return false;
    for(let d=o0; d<=o1; d++){ const y1 = yc+d, y2 = yc-d; if(y1 >= 0 && y1 < h) o += ink[y1*w+x]; if(y2 >= 0 && y2 < h) o += ink[y2*w+x]; }
    return o/no < 0.5*b/nb;
  };
  xm = Math.max(0, Math.min(w-1, Math.round(xm)));
  let l = xm, r = xm;
  for(let x=xm, g=0; x>=Math.max(0, xlo); x--){ if(isText(x)){ l = x; g = 0; } else if(++g > gapMax) break; }
  for(let x=xm, g=0; x<=Math.min(w-1, xhi); x++){ if(isText(x)){ r = x; g = 0; } else if(++g > gapMax) break; }
  return [l, r];
}
/* satırı eğime uyarak yeniden izle: zincirin ortasından iki yana küçük adımlarla; her adımda
   o anki eğime göre kaydırılmış kısa bir pencerede satır ortası aranır. Sırt tarafındaki kıvrımda
   (satır hızla bükülür) bulanık iz satırları karıştırır, bu izleyici bükülmeyi takip eder.
   Satırın zincirleri tek bir ize indirgenir (uçlar: mürekkebin bittiği yer). */
function txFollow(ink, w, h, p, row){
  const dx = Math.max(2, Math.round(p/5)), hw = Math.max(2, Math.round(p*0.5)), J = Math.max(3, Math.ceil(p*0.6)), sr = Math.max(1, Math.round(p*0.18));
  const NJ = 2*J+1, prof = new Float32Array(NJ), sm = new Float32Array(NJ), lim = Math.max(1, Math.round(p*0.35));
  const c0 = row.chains.reduce((a, b) => (b.x1 - b.x0) > (a.x1 - a.x0) ? b : a);
  const xs0 = Math.round((c0.x0 + c0.x1)/2);
  const measure = (x, yPred, m) => {
    prof.fill(0);
    for(let t=-hw; t<=hw; t++){
      const xx = x + t; if(xx < 0 || xx >= w) continue;
      const y0 = Math.round(yPred + m*t) - J;
      for(let j=0;j<NJ;j++){ const yy = y0 + j; if(yy >= 0 && yy < h) prof[j] += ink[yy*w+xx]; }
    }
    let best = -1, bj = J, mn = 1e9;
    for(let j=0;j<NJ;j++){ let q = 0; for(let e=-sr;e<=sr;e++){ const k = j+e; if(k >= 0 && k < NJ) q += prof[k]; } sm[j] = q; if(q < mn) mn = q; }
    for(let j=J-lim; j<=J+lim; j++) if(sm[j] > best){ best = sm[j]; bj = j; }
    let off = bj - J;
    if(bj > 0 && bj < NJ-1){ const den = sm[bj-1] - 2*sm[bj] + sm[bj+1]; if(den < 0) off += 0.5*(sm[bj-1] - sm[bj+1])/den; }
    return {off, v: best, con: best > 0 ? (best - mn)/best : 0, edge: bj === J-lim || bj === J+lim};
  };
  const m0 = (c0.yAt(xs0 + p) - c0.yAt(xs0 - p))/(2*p);
  const walk = dir => {
    let x = xs0, y = c0.yAt(xs0), m = m0, gap = 0, vRef = 0, nv = 0, nKeep = 0;
    const out = [], hist = [[x, y]];
    for(;;){
      const xn = x + dir*dx;
      if(xn < 1 || xn > w-2) break;
      const yPred = y + m*dir*dx;
      if(yPred < J+1 || yPred > h-J-2) break;
      const r = measure(xn, yPred, m);
      const ok = r.v > (nv > 5 ? vRef*0.22 : sr*0.6) && r.con > 0.35 && !r.edge;
      let yn = yPred;
      if(ok){
        yn = yPred + r.off*0.85;
        vRef = (vRef*nv + r.v)/(nv + 1); if(nv < 40) nv++;
        gap = 0;
        hist.push([xn, yn]); if(hist.length > 9) hist.shift();
        if(hist.length >= 4){
          let sx=0, sy=0, sxx=0, sxy=0; const n = hist.length;
          for(const q of hist){ sx += q[0]; sy += q[1]; sxx += q[0]*q[0]; sxy += q[0]*q[1]; }
          const den = n*sxx - sx*sx; if(den) m = 0.5*m + 0.5*(n*sxy - sx*sy)/den;
        }
      } else { gap += dx; if(gap > p*1.4) break; }
      out.push(yn); if(ok) nKeep = out.length;
      x = xn; y = yn;
    }
    out.length = nKeep;                              // mürekkepsiz kuyruk atılır
    return out;
  };
  const rgt = walk(1), lft = walk(-1);
  const n = lft.length + 1 + rgt.length;
  if(n < 5) return null;
  const raw = new Float32Array(n);
  for(let i=0;i<lft.length;i++) raw[lft.length-1-i] = lft[i];
  raw[lft.length] = c0.yAt(xs0);
  for(let i=0;i<rgt.length;i++) raw[lft.length+1+i] = rgt[i];
  const ys = new Float32Array(n);
  for(let i=0;i<n;i++){ let q = 0, k = 0; for(let j=-1;j<=1;j++){ const t = i+j; if(t >= 0 && t < n){ q += raw[t]; k++; } } ys[i] = q/k; }
  const c = txMkChain(xs0 - lft.length*dx, dx, ys, c0.amp);
  const e = txEnds(ink, w, h, p, c, xs0, c.xa - hw, c.xb + hw);
  const l = e[0], r = e[1];
  c.x0 = l; c.x1 = r;
  return c;
}
/* düzgün aralıklı örneklerden iz nesnesi */
function txMkChain(xa, dx, ys, amp){
  const n = ys.length, c = {k0: 0, n, ys, dx, amp: amp || 0, xa, xb: xa + (n-1)*dx};
  let sx=0, sy=0, sxx=0, sxy=0;
  for(let i=0;i<n;i++){ const x = xa + i*dx; sx += x; sy += ys[i]; sxx += x*x; sxy += x*ys[i]; }
  const den = n*sxx - sx*sx; c.slope = den ? (n*sxy - sx*sy)/den : 0; c.icpt = (sy - c.slope*sx)/n;
  c.yAt = x => {
    const f = (x - c.xa)/dx;
    if(f <= 0){ const m = Math.min(6, n-1); return ys[0] + (ys[m] - ys[0])/(m*dx)*(x - c.xa); }
    if(f >= n-1){ const m = Math.min(6, n-1); return ys[n-1] + (ys[n-1] - ys[n-1-m])/(m*dx)*(x - c.xb); }
    const i = f|0, t = f - i; return ys[i]*(1-t) + ys[i+1]*t;
  };
  c.x0 = c.xa; c.x1 = c.xb;
  return c;
}
/* satır nesnesi (zincirleri soldan sağa) */
function txMkRow(cs, p){
  cs.sort((a, b) => a.x0 - b.x0);
  const x0 = cs[0].x0, x1 = Math.max(...cs.map(c => c.x1));
  const yAt = x => { let best = cs[0], bd = 1e9; for(const c of cs){ const d = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0; if(d < bd){ bd = d; best = c; } } return best.yAt(x); };
  let n2=0, sX=0, sY=0, sXX=0, sXY=0;
  for(const c of cs) for(let i=0;i<c.n;i++){ const x = c.xa + i*c.dx; if(x < c.x0 - p || x > c.x1 + p) continue; n2++; sX += x; sY += c.ys[i]; sXX += x*x; sXY += x*c.ys[i]; }
  const den = n2*sXX - sX*sX, slope = den ? (n2*sXY - sX*sY)/den : 0, icpt = n2 ? (sY - slope*sX)/n2 : 0;
  const len = cs.reduce((q, c) => q + (c.x1 - c.x0), 0);
  return {chains: cs, x0, x1, yAt, slope, icpt, xm: (x0+x1)/2, ym: icpt + slope*(x0+x1)/2, len};
}
/* zincirleri yazı bloklarına (sayfa sütunlarına) kümele; satırlara ayır.
   Dönen: kümeler [{rows:[{chains, x0, x1, y(x), ym}], len, cx, cy}] uzunluğa göre azalan */
function txBlocks(chains, p, w, h){
  const n = chains.length, par = new Int32Array(n), rowPar = new Int32Array(n), dead = new Uint8Array(n);
  for(let i=0;i<n;i++){ par[i] = i; rowPar[i] = i; }
  const find = (P, i) => { while(P[i] !== i){ P[i] = P[P[i]]; i = P[i]; } return i; };
  const uni = (P, a, b) => { a = find(P, a); b = find(P, b); if(a !== b) P[a] = b; };
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    const A = chains[i], B = chains[j];
    const o0 = Math.max(A.x0, B.x0), o1 = Math.min(A.x1, B.x1), ov = o1 - o0;
    const lenA = A.x1 - A.x0, lenB = B.x1 - B.x0;
    if(ov > Math.min(lenA, lenB)*0.5 && ov > p*1.5){
      let d = 0; for(let k=0;k<5;k++){ const x = o0 + ov*(k+0.5)/5; d += Math.abs(A.yAt(x) - B.yAt(x)); } d /= 5;
      if(d < p*0.45){ dead[lenA < lenB ? i : j] = 1; uni(par, i, j); }
      else if(d <= p*2.6) uni(par, i, j);
    } else if(ov <= p*0.5){
      const Lc = A.x0 < B.x0 ? A : B, Rc = Lc === A ? B : A, gap = Rc.x0 - Lc.x1;
      if(gap < p*1.0){
        const xm = (Lc.x1 + Rc.x0)/2;
        if(Math.abs(Lc.yAt(xm) - Rc.yAt(xm)) < p*0.3){ uni(par, i, j); uni(rowPar, i, j); }
      }
    }
  }
  const groups = new Map();
  for(let i=0;i<n;i++){ if(dead[i]) continue; const r = find(par, i); if(!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const out = [];
  for(const idx of groups.values()){
    const rowsM = new Map();
    for(const i of idx){ const r = find(rowPar, i); if(!rowsM.has(r)) rowsM.set(r, []); rowsM.get(r).push(chains[i]); }
    const rows = [];
    let len = 0, sx = 0, sy = 0;
    for(const cs of rowsM.values()){
      const r = txMkRow(cs, p);
      rows.push(r);
      len += r.len; sx += r.len*r.xm; sy += r.len*r.ym;
    }
    rows.sort((a, b) => a.ym - b.ym);
    const cx = sx/len, cy = sy/len;
    const cw = 1 - 0.45*Math.min(1, Math.hypot((cx - w/2)/(w/2), (cy - h/2)/(h/2)));
    out.push({rows, len, cx, cy, score: len*cw});
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
/* kenar hizası: x = a + b·y. Nokta çiftlerinden geçen doğrulardan en çok noktayı ±tol içinde
   tutan; dışına (dir yönünde) taşan nokta cezalıdır (yazı kenarın dışında olamaz) */
function txEdge(pts, tol, dir){
  const n = pts.length;
  if(n < 3) return null;
  let ymin = 1e9, ymax = -1e9; for(const q of pts){ if(q[0] < ymin) ymin = q[0]; if(q[0] > ymax) ymax = q[0]; }
  const span = ymax - ymin;
  let best = null;
  const evalLine = (a, b) => { let inl = 0, vio = 0; for(const q of pts){ const r = q[1] - (a + b*q[0]); if(Math.abs(r) <= tol) inl++; else if(dir*r > tol) vio++; } return {a, b, inl, vio, sc: inl - 2.5*vio}; };
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    const dy = pts[j][0] - pts[i][0];
    if(Math.abs(dy) < span*0.3) continue;
    const b = (pts[j][1] - pts[i][1])/dy;
    if(Math.abs(b) > 0.6) continue;
    const e = evalLine(pts[i][1] - b*pts[i][0], b);
    if(!best || e.sc > best.sc) best = e;
  }
  if(!best) return null;
  // iç noktalarla en küçük kareler
  for(let it=0; it<2; it++){
    let sw=0, sy=0, sx=0, syy=0, sxy=0;
    for(const q of pts){ const r = q[1] - (best.a + best.b*q[0]); if(Math.abs(r) > tol) continue; sw++; sy += q[0]; sx += q[1]; syy += q[0]*q[0]; sxy += q[0]*q[1]; }
    const den = sw*syy - sy*sy;
    if(sw < 3 || Math.abs(den) < 1e-9) break;
    const b = (sw*sxy - sy*sx)/den, a = (sx - b*sy)/sw;
    const e = evalLine(a, b);
    if(e.sc >= best.sc) best = e; else break;
  }
  return {a: best.a, b: best.b, inl: best.inl/n, n: best.inl, vio: best.vio};
}

/* 1. aşama: yön + satır izleri + ana yazı bloğu + yazı dörtgeni.
   Dönen: null (yazı yok) ya da {rot, p, chains, blocks, main, L, R, quadR (döndürülmüş), quad (kaynak), rows, dbg} */
function txFind(src, opts){
  opts = opts || {};
  const W = src.width, H = src.height, dbg = [];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()); let t0 = now(); const tm = [];
  const TT = n => { const t = now(); tm.push(n + ':' + Math.round(t - t0)); t0 = t; };
  const sd = opts.sd || imgData(src).data;
  const s0 = Math.min(1, (opts.quick ? 520 : 640)/Math.max(W, H));
  const c0 = s0 < 1 ? downscale(src, Math.round(W*s0), Math.round(H*s0)) : src;
  const w0 = c0.width, h0 = c0.height;
  const g0 = toGray(imgData(c0));
  TT('küçült');
  const ink00 = inkOf(g0, w0, h0);
  let or = opts.angHint != null ? txOrient(ink00, w0, h0, opts.angHint) : null;
  // ipucuyla bulunan açı pencerenin kenarındaysa ya da yazı karosu azsa tam tarama
  if(or && (Math.abs(or.ang - opts.angHint) > 10*Math.PI/180 || or.nt < 5 || !or.pitch)) or = null;
  if(!or) or = txOrient(ink00, w0, h0);
  TT('yön');
  if(!or || !or.pitch){ dbg.push('yön yok ' + (or ? 'aralık yok açı ' + (or.ang*180/Math.PI).toFixed(1) + ' karo ' + or.nt : G.__orWhy)); return {ok: false, dbg}; }
  dbg.push(`yön${or.hinted ? '(ipucu)' : ''} ${(or.ang*180/Math.PI).toFixed(1)}° A${or.A.toFixed(3)} B${(or.B*h0).toFixed(3)} p≈${(or.pitch/s0).toFixed(0)} karo ${or.nt}/${or.nTiles}`);
  // hızlı kontrolde çalışma ölçeği yazı boyuna göre seçilir (satır aralığı ≈ 10.5 px): iri yazıda küçük, ufak yazıda büyük
  const maxSide = opts.quick ? Math.round(Math.max(520, Math.min(820, 10.5/(or.pitch/s0)*Math.max(W, H)))) : (opts.maxSide || 1100);
  const run = (a) => {
    const rot = txWarp(src, Object.assign({}, or, {ang: a}), s0, maxSide);
    TT('çarpıt');
    const {ink, gray} = txInk(rot.g, rot.valid, rot.w, rot.h);
    TT('mürekkep');
    const p = or.pitch/s0*rot.sc;
    const tr = txTrace(ink, rot.w, rot.h, p);
    TT('iz');
    const blocks = txBlocks(tr.chains, p, rot.w, rot.h);
    TT('küme');
    if(blocks.length && opts.follow !== false){
      const mb = blocks[0], nr = [];
      for(const r of mb.rows){
        const c = txFollow(ink, rot.w, rot.h, p, r);
        // yeniden izleme satırı kısaltıyorsa (takip koptu) eski zincirler kalır
        if(c && (c.x1 - c.x0) >= (r.x1 - r.x0)*0.9) nr.push(txMkRow([c], p)); else nr.push(r);
      }
      // aynı satıra düşen izler (parçalı zincirler birleşince) tekilleştirilir
      nr.sort((x, y) => (y.x1 - y.x0) - (x.x1 - x.x0));
      const keep = [];
      for(const r of nr){
        let dup = false;
        for(const k of keep){
          const o0 = Math.max(r.x0, k.x0), o1 = Math.min(r.x1, k.x1);
          if(o1 - o0 > (r.x1 - r.x0)*0.5){ const xm = (o0 + o1)/2; if(Math.abs(r.yAt(xm) - k.yAt(xm)) < p*0.4){ dup = true; break; } }
        }
        if(!dup) keep.push(r);
      }
      keep.sort((x, y) => x.ym - y.ym);
      mb.rows = keep;
      TT('izle');
    }
    return {rot, ink, gray, p, chains: tr.chains, blocks, S: tr.S, ang: a};
  };
  let st = run(or.ang);
  if(!st.blocks.length || st.blocks[0].rows.length < 3){ dbg.push('blok yok'); return {ok: false, dbg, st}; }
  let q = txQuad(st, dbg);
  const sideways0 = Math.abs(or.ang) > 50*Math.PI/180;
  if(q.ok && (sideways0 || !opts.quick)){
    const u = txUpCues(st, q, sd, W, H);
    // puan > 0: yazı dik. Kadraja göre dik duran yazı (|açı| ≤ 50°) ancak çok güçlü kanıtla ters sayılır
    const sc = Math.log(u.ratio) + Math.max(-1.5, Math.min(1.5, 0.35*(u.nE - u.nS))) + Math.max(-0.8, Math.min(0.8, 0.2*(u.nIndS - u.nIndE)));
    const sideways = Math.abs(or.ang) > 50*Math.PI/180;
    dbg.push(`dik puanı ${sc.toFixed(2)} (taşma ${u.asc}/${u.desc}, kısa ${u.nS}/${u.nE}, girinti ${u.nIndS}/${u.nIndE})`);
    // kadraja göre dik duran yazı ancak harf biçimi de ters diyorsa çevrilir (sağa yaslı şiir vb. yanıltmasın)
    if(opts.flip !== false && (sideways ? sc < 0 : (sc < -1.3 && Math.log(u.ratio) < -0.2))){
      dbg.push('baş aşağı → 180°');
      st = run(or.ang + Math.PI);
      if(!st.blocks.length || st.blocks[0].rows.length < 3){ dbg.push('blok yok'); return {ok: false, dbg, st}; }
      q = txQuad(st, dbg);
      q.flipped = true;
    }
    q.upScore = sc;
    TT('dik');
  }
  dbg.push('süre ' + tm.join(' '));
  return Object.assign(q, {st, dbg, or});
}
/* ana bloğun kenar hizaları ve yazı dörtgeni (döndürülmüş koordinatlarda) */
function txQuad(st, dbg){
  const main = st.blocks[0], rows = main.rows, p = st.p;
  // satır aralığı: komşu satır ortalarının ortancası
  const gaps = []; for(let i=1;i<rows.length;i++){ const x = (Math.max(rows[i].x0, rows[i-1].x0) + Math.min(rows[i].x1, rows[i-1].x1))/2; const d = rows[i].yAt(x) - rows[i-1].yAt(x); if(d > p*0.5 && d < p*1.7) gaps.push(d); }
  const pitch = gaps.length >= 3 ? quantile(gaps, 0.5) : p;
  const tol = pitch*0.4;
  const Lp = rows.map(r => [r.yAt(r.x0), r.x0]), Rp = rows.map(r => [r.yAt(r.x1), r.x1]);
  let L = txEdge(Lp, tol, -1), R = txEdge(Rp, tol, 1);
  const okL = L && L.inl >= 0.4 && L.n >= 3, okR = R && R.inl >= 0.4 && R.n >= 3;
  const par = (ref, pts, q) => { const offs = pts.map(t => t[1] - (ref.a + ref.b*t[0])); return {a: ref.a + quantile(offs, q), b: ref.b, inl: 0, n: 0, vio: 0, par: true}; };
  if(okL && !okR) R = par(L, Rp, 0.92);
  else if(!okL && okR) L = par(R, Lp, 0.08);
  else if(!okL && !okR){ const z = {a: 0, b: 0}; L = par(z, Lp, 0.08); R = par(z, Rp, 0.92); }
  const Lf = y => L.a + L.b*y, Rf = y => R.a + R.b*y;
  // tam satırlar: iki kenara da (ya da genişliğin çoğuna) uzanan
  const bwid = r => Rf(r.ym) - Lf(r.ym);
  const full = rows.filter(r => (r.x1 - r.x0) > bwid(r)*0.72 && Math.abs(r.x0 - Lf(r.yAt(r.x0))) < pitch*2.2);
  const use = full.length >= 2 ? full : rows.filter(r => (r.x1 - r.x0) > bwid(r)*0.45);
  if(use.length < 2){ dbg.push('tam satır yok'); return {ok: false}; }
  // eğim, y'nin doğrusal işlevi (perspektif): sağlam uyum
  let s0 = 0, s1 = 0; const yc = (use[0].ym + use[use.length-1].ym)/2;
  { let keep = use.map(() => true);
    for(let it=0; it<3; it++){
      let n=0, sy=0, ss=0, syy=0, sys=0;
      use.forEach((r, i) => { if(!keep[i]) return; const y = r.ym - yc, wt = 1; n += wt; sy += y; ss += r.slope; syy += y*y; sys += y*r.slope; });
      const den = n*syy - sy*sy;
      if(n >= 4 && Math.abs(den) > 1e-9){ s1 = (n*sys - sy*ss)/den; s0 = (ss - s1*sy)/n; } else { s1 = 0; s0 = n ? ss/n : 0; }
      const res = use.map(r => Math.abs(r.slope - (s0 + s1*(r.ym - yc))));
      const lim = Math.max(0.004, quantile(res, 0.5)*3);
      keep = res.map(v => v <= lim);
    } }
  const slopeAt = y => s0 + s1*(y - yc);
  const top = use[0], bot = use[use.length-1];
  const corner = (row, edge) => {
    const st2 = slopeAt(row.ym), xt = row.xm, yt = row.icpt + row.slope*row.xm;
    const x = (edge.a + edge.b*(yt - st2*xt))/(1 - edge.b*st2);
    return [x, yt + st2*(x - xt)];
  };
  const quadR = [corner(top, L), corner(top, R), corner(bot, R), corner(bot, L)];
  const quad = quadR.map(q => st.rot.toSrc(q[0], q[1]));
  dbg.push(`blok ${rows.length} satır (tam ${full.length}) aralık ${pitch.toFixed(1)} L(inl ${L.inl.toFixed(2)} b ${L.b.toFixed(3)}) R(inl ${R.inl.toFixed(2)} b ${R.b.toFixed(3)}${R.par ? ' par' : ''}) eğim ${s0.toFixed(3)}+${s1.toFixed(5)}y`);
  return {ok: true, main, rows, L, R, okL, okR, pitch, quadR, quad, top, bot, full: use, slopeAt};
}

/* yazı baş aşağı mı? İki ipucu: (1) harf sütunlarının üst ucu çoğunlukla gövde çizgisindedir ama
   uzun harfler (b d k l, büyük harf, nokta) yukarı taşar; aşağı taşan (g p y) çok daha azdır —
   en uzun satırlar KAYNAK çözünürlüğünde, sütun sütun ölçülür;
   (2) paragraf sonu kısa satırlar sağda biter, girinti soldadır */
function txUpCues(st, q, sd, W, H){
  const {rot} = st, pt = q.pitch;
  const rows = q.full.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0)).slice(0, 14);
  const step = 0.5, D = Math.max(4, Math.round(pt*0.55/step)), NP = 2*D+1;
  const col = new Float32Array(NP);
  const W1 = W - 1.001, H1 = H - 1.001, thrD = Math.max(2, Math.round(pt*0.11/step));
  let asc = 0, desc = 0, ncol = 0;
  for(const row of rows){
    const x0 = row.x0 + (row.x1 - row.x0)*0.03, x1 = row.x1 - (row.x1 - row.x0)*0.03;
    const tops = [], bots = [];
    const hT = new Int32Array(NP), hB = new Int32Array(NP);
    for(let x=x0; x<=x1; x+=0.5){
      const yc = row.yAt(x);
      const a = rot.toSrc(x, yc - D*step), b = rot.toSrc(x, yc + D*step);
      let mx = 0, ok = true;
      for(let j=0;j<NP;j++){
        const t = j/(NP-1), sx = a[0] + (b[0]-a[0])*t, sy = a[1] + (b[1]-a[1])*t;
        if(sx < 0 || sy < 0 || sx > W1 || sy > H1){ ok = false; break; }
        const xi = sx|0, yi = sy|0, tx = sx-xi, ty = sy-yi, o = (yi*W+xi)*4, o2 = o + W*4;
        const g = ((0.299*sd[o]+0.587*sd[o+1]+0.114*sd[o+2])*(1-tx) + (0.299*sd[o+4]+0.587*sd[o+5]+0.114*sd[o+6])*tx)*(1-ty)
                + ((0.299*sd[o2]+0.587*sd[o2+1]+0.114*sd[o2+2])*(1-tx) + (0.299*sd[o2+4]+0.587*sd[o2+5]+0.114*sd[o2+6])*tx)*ty;
        col[j] = g; if(g > mx) mx = g;
      }
      if(!ok || mx < 30) continue;
      const th = mx*0.72;
      let top = -1, bot = -1;
      for(let j=0;j<NP-1;j++) if(col[j] < th && col[j+1] < th){ top = j; break; }
      if(top < 0) continue;
      for(let j=NP-1;j>0;j--) if(col[j] < th && col[j-1] < th){ bot = j; break; }
      tops.push(top); bots.push(bot); hT[top]++; hB[bot]++;
    }
    if(tops.length < 30) continue;
    // en sık üst ve alt uç (3'lü pencere)
    let mT = 1, mB = 1, bt = -1, bb = -1;
    for(let j=1;j<NP-1;j++){ const vt = hT[j-1]+hT[j]+hT[j+1], vb = hB[j-1]+hB[j]+hB[j+1]; if(vt > bt){ bt = vt; mT = j; } if(vb > bb){ bb = vb; mB = j; } }
    if(mB - mT < pt*0.2/step) continue;
    for(let k=0;k<tops.length;k++){ if(tops[k] < mT - thrD) asc++; if(bots[k] > mB + thrD) desc++; }
    ncol += tops.length;
  }
  let nS = 0, nE = 0, nIndS = 0, nIndE = 0;
  const Lf = y => q.L.a + q.L.b*y, Rf = y => q.R.a + q.R.b*y;
  for(const r of q.rows){
    const ds = r.x0 - Lf(r.yAt(r.x0)), de = Rf(r.yAt(r.x1)) - r.x1;
    if(ds < -pt || de < -pt) continue;
    if(ds > pt*4) nS++; else if(ds > pt*0.6 && ds < pt*2.2) nIndS++;
    if(de > pt*4) nE++; else if(de > pt*0.6 && de < pt*2.2) nIndE++;
  }
  return {asc, desc, ncol, ratio: (asc + ncol*0.01 + 1)/(desc + ncol*0.01 + 1), nS, nE, nIndS, nIndE};
}

/* 2. aşama: yazı düzlemi (yazı dörtgeninin perspektifi, kenar payıyla genişletilmiş) ve satır
   izlerinden kıvrım alanı. Dönen P, analyzePlane çıktısıyla uyumludur (contentBox, marginMap,
   lineSigs doğrudan kullanır): {toSrc, bw, bh, margins, tb, pitch, ink, gray, srcPerPx, ...} */
function txPlane(sd, W, H, f, quick, dbg){
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()); let t0 = now(); const tm = [];
  const TT = n => { const t = now(); tm.push(n + ':' + Math.round(t - t0)); t0 = t; };
  const st = f.st, rot = st.rot, tq = f.quad;
  if(!tq.every(q => isFinite(q[0]) && isFinite(q[1])) || !isConvex(tq)){ dbg.push('yazı dörtgeni geçersiz'); return null; }
  const U = [[0,0],[1,0],[1,1],[0,1]];
  const HT = homography(U, tq), HTi = homography(tq, U);
  if(!HT || !HTi) return null;
  const toUV = (xr, yr) => { const q = rot.toSrc(xr, yr); return applyH(HTi, q[0], q[1]); };
  // satırlar (u,v) birimlerinde
  const mainSet = new Set(f.rows);
  const all = [];
  st.blocks.forEach((b, bi) => { for(const r of b.rows){
    const pts = [];
    for(const c of r.chains) for(let i=0;i<c.n;i++){ const x = c.xa + i*c.dx; if(x < c.x0 - c.dx || x > c.x1 + c.dx) continue; pts.push(toUV(x, c.ys[i])); }
    if(pts.length < 2) continue;
    pts.sort((a, b2) => a[0] - b2[0]);
    const e0 = toUV(r.x0, r.yAt(r.x0)), e1 = toUV(r.x1, r.yAt(r.x1));
    let vm = 0; for(const q of pts) vm += q[1]; vm /= pts.length;
    all.push({row: r, main: mainSet.has(r), bi, pts, u0: e0[0], u1: e1[0], vm});
  } });
  const mains = all.filter(r => r.main).sort((a, b) => a.vm - b.vm);
  if(mains.length < 3) return null;
  const dv = []; for(let i=1;i<mains.length;i++){ const d = mains[i].vm - mains[i-1].vm; if(d > 0) dv.push(d); }
  const pv = quantile(dv, 0.5);                       // satır aralığı (v)
  if(!(pv > 0)) return null;
  const pu = pv*((dist(tq[0],tq[3]) + dist(tq[1],tq[2]))/(dist(tq[0],tq[1]) + dist(tq[3],tq[2])));   // ≈ aynı uzunluk, u biriminde
  // düzlemin kapsamı: bloğun dışındaki kendi satırları + başlık / sayfa no payı, kadraj içinde kalarak
  const vTop = Math.min(0, mains[0].vm), vBot = Math.max(1, mains[mains.length-1].vm);
  const mg = 0.03*Math.max(W, H);
  const inFrame = (u, v) => { const q = applyH(HT, u, v); return q[0] > -mg && q[1] > -mg && q[0] < W + mg && q[1] < H + mg; };
  const extCap = (quick ? 8 : 20)*pv;
  const ext = (v0, dir) => { let e = extCap; while(e > 2.5*pv && !(inFrame(0.15, v0 + dir*e) || inFrame(0.5, v0 + dir*e) || inFrame(0.85, v0 + dir*e))) e -= pv; return e; };
  const exT0 = ext(vTop, -1), exB0 = ext(vBot, 1);
  // pay üst sınıra dayandıysa düzlemin ucu kadrajın ucu değildir (orada biten tarama 'kesik' sayılmaz)
  let capT = exT0 >= extCap - 1e-9, capB = exB0 >= extCap - 1e-9;
  let eyT = -vTop + exT0, eyB = (vBot - 1) + exB0;
  let exL = Math.max(0.18, 4*pu), exR = exL;
  let qB = null;
  for(let it=0; it<6; it++){
    const qq = [[-exL,-eyT],[1+exR,-eyT],[1+exR,1+eyB],[-exL,1+eyB]].map(([u,v]) => applyH(HT, u, v));
    if(qq.every(q => isFinite(q[0]) && isFinite(q[1])) && isConvex(qq) && quadArea(qq) < W*H*6){ qB = qq; break; }
    eyT = -vTop + (eyT + vTop)*0.6; eyB = (vBot - 1) + (eyB - vBot + 1)*0.6; exL *= 0.75; exR *= 0.75; capT = capB = true;
  }
  if(!qB){ dbg.push('düzlem kurulamadı'); return null; }
  const totV = 1 + eyT + eyB, totX = 1 + exL + exR;
  const arT = estimateAspect(tq, W, H);
  let tp = quick ? 13 : 22;                             // düzlemde satır aralığı (px)
  let Hb = Math.round(totV/pv*tp);
  const HbMax = quick ? 1000 : 2000; if(Hb > HbMax){ tp *= HbMax/Hb; Hb = HbMax; }
  let Wb = Math.max(64, Math.round(Hb*arT*totX/totV));
  if(Wb > 1700){ const k = 1700/Wb; Wb = 1700; Hb = Math.round(Hb*k); tp *= k; }
  const hm = homography([[0,0],[Wb,0],[Wb,Hb],[0,Hb]], qB);
  if(!hm) return null;
  const MK = [254, 1, 253];
  const g0 = new Float32Array(Wb*Hb), outM = new Uint8Array(Wb*Hb);
  if(quick){
    // hızlı kontrol: düzlem doğrudan gri örneklenir (renkli ara görüntü yok)
    const gs = f.gsrc || grayOf(sd, W*H);
    const grid = buildGrid(Wb, Hb, 8, (u, v) => applyH(hm, u, v)), {gw, gs: GS, mx, my} = grid, ls = [];
    for(let v=0; v<Hb; v++){
      const gyf = v/GS, gy = gyf|0, fy = gyf-gy;
      for(let u=0; u<Wb; u++){
        const gxf = u/GS, gx = gxf|0, fx = gxf-gx, i00 = gy*gw+gx, i01 = i00+gw, i = v*Wb+u;
        const a0=(1-fx)*(1-fy), a1=fx*(1-fy), a2=(1-fx)*fy, a3=fx*fy;
        let x = mx[i00]*a0 + mx[i00+1]*a1 + mx[i01]*a2 + mx[i01+1]*a3;
        let y = my[i00]*a0 + my[i00+1]*a1 + my[i01]*a2 + my[i01+1]*a3;
        if(!(x >= -1 && y >= -1 && x <= W && y <= H)){ outM[i] = 1; continue; }
        x = x < 0 ? 0 : x > W-1.001 ? W-1.001 : x; y = y < 0 ? 0 : y > H-1.001 ? H-1.001 : y;
        const xi = x|0, yi = y|0, tx = x-xi, ty = y-yi, q = yi*W+xi;
        const gv = (gs[q]*(1-tx) + gs[q+1]*tx)*(1-ty) + (gs[q+W]*(1-tx) + gs[q+W+1]*tx)*ty;
        g0[i] = gv;
        if(i % 11 === 0 && gv > 110) ls.push(gv);
      }
    }
    const pc = ls.length ? quantile(ls, 0.7) : 235;
    for(let i=0;i<Wb*Hb;i++) if(outM[i]) g0[i] = pc;
  } else {
    const rect = remap(sd, W, H, Wb, Hb, buildGrid(Wb, Hb, 8, (u, v) => applyH(hm, u, v)), false, MK);
    const ls = [];
    for(let i=0, j=0; i<Wb*Hb; i++, j+=4){
      if(rect[j] === MK[0] && rect[j+1] === MK[1] && rect[j+2] === MK[2]){ outM[i] = 1; continue; }
      g0[i] = 0.299*rect[j] + 0.587*rect[j+1] + 0.114*rect[j+2];
      if(i % 11 === 0 && g0[i] > 110) ls.push(g0[i]);
    }
    const pc = ls.length ? quantile(ls, 0.7) : 235;
    for(let i=0;i<Wb*Hb;i++) if(outM[i]) g0[i] = pc;
  }
  TT('örnekle');
  const ink0 = inkOf(g0, Wb, Hb);
  for(let i=0;i<Wb*Hb;i++) if(outM[i]) ink0[i] = 0;
  TT('mürekkep');
  // satırlar düzlem pikselinde
  const PX = u => (u + exL)/totX*Wb, PY = v => (v + eyT)/totV*Hb;
  const pitch = pv/totV*Hb;
  for(const r of all){
    r.X = r.pts.map(q => PX(q[0])); r.Y = r.pts.map(q => PY(q[1]));
    r.X0 = PX(r.u0); r.X1 = PX(r.u1);
    r.at = X => {                                        // satırın X'teki Y'si (uçlarda sabit eğimle)
      const n = r.X.length; if(X <= r.X[0]) return r.Y[0]; if(X >= r.X[n-1]) return r.Y[n-1];
      let lo = 0, hi = n-1; while(hi - lo > 1){ const m = (lo+hi)>>1; if(r.X[m] <= X) lo = m; else hi = m; }
      const t = (X - r.X[lo])/Math.max(1e-6, r.X[hi] - r.X[lo]); return r.Y[lo]*(1-t) + r.Y[hi]*t;
    };
  }
  // sütunun içindeki satırlar: ana blok + sütun aralığına düşen diğer izler (başlık, alıntı, ayrı paragraf)
  const xa = PX(0), xb = PX(1);
  const inCol = r => r.X0 > xa - pitch*1.5 && r.X1 < xb + pitch*1.5;
  const rows = all.filter(r => r.main ? (r.X1 > xa && r.X0 < xb) : (inCol(r) && r.vm > vTop - 14*pv && r.vm < vBot + 14*pv));
  // ortak satır biçimi C(X): tam satırların blok ortasına göre sapmasının ortancası
  const fullSet = new Set(f.full), fulls = rows.filter(r => fullSet.has(r.row));
  const GX = 16, ngx = Math.floor((Wb-1)/GX) + 2, Xmid = (xa + xb)/2;
  const C = new Float32Array(ngx);
  for(let gx=0; gx<ngx; gx++){
    const X = Math.max(xa, Math.min(xb, gx*GX)), vs = [];
    for(const r of fulls) if(X >= r.X[0] - GX && X <= r.X[r.X.length-1] + GX) vs.push(r.at(X) - r.at(Xmid));
    C[gx] = vs.length ? quantile(vs, 0.5) : 0;
  }
  const Cat = X => { const f2 = Math.max(0, Math.min(ngx-1.001, X/GX)), i = f2|0, t = f2 - i; return C[i]*(1-t) + C[i+1]*t; };
  for(const r of rows){ const vs = r.X.map((X, k) => r.Y[k] - Cat(X)); r.yref = quantile(vs, 0.5); }
  rows.sort((a, b) => a.yref - b.yref);
  // kıvrım alanı: ızgara sütunu × satır → düşey kayma; satırlar arasında doğrusal
  const GY = 8, ngy = Math.floor((Hb-1)/GY) + 2;
  const F = new Float32Array(ngx*ngy), has = new Uint8Array(ngx);
  // Alana yalnız GÜVENİLİR satırlar girer: ana blok + en az 3 satırlı, satır aralığı gövdeye benzeyen kümeler.
  // Tek başına duran satırların (büyük puntolu başlık, üst başlık, sayfa no) izi güvenilmezdir: harfler satır
  // aralığından büyük olunca iz dalgalanır ve başlığı eğer. Bunlar komşu gövde satırlarının biçimiyle düzeltilir.
  const fieldRows = (() => {
    const byB = new Map(); for(const r of rows){ if(!byB.has(r.bi)) byB.set(r.bi, []); byB.get(r.bi).push(r); }
    const okB = new Set();
    for(const [bi, rs] of byB){
      if(rs.length < 3) continue;
      const gs = []; for(let i=1;i<rs.length;i++) gs.push(rs[i].yref - rs[i-1].yref);
      const g = quantile(gs, 0.5);
      if(g > pitch*0.7 && g < pitch*1.5) okB.add(bi);
    }
    const fr = rows.filter(r => r.main || okB.has(r.bi));
    return fr.length >= 3 ? fr : rows;
  })();
  const med3 = (a, b, c) => a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
  for(let gx=0; gx<ngx; gx++){
    const X = gx*GX, list = [];
    for(const r of fieldRows){ if(X < r.X[0] - GX*0.75 || X > r.X[r.X.length-1] + GX*0.75) continue; list.push([r.yref, r.at(X) - r.yref]); }
    if(!list.length) continue;
    has[gx] = 1;
    // komşu satırlarla uzlaşma: tek bir satırın izleme hatası (ör. kıvrımda komşu satıra kayma) alana geçmez
    { const n = list.length, near = (i, j) => j >= 0 && j < n && Math.abs(list[j][0] - list[i][0]) < pitch*3.2;
      const dv = new Float32Array(n);
      for(let i=0;i<n;i++){
        const c = list[i][1];
        if(near(i, i-1) && near(i, i+1)) dv[i] = med3(list[i-1][1], c, list[i+1][1]);
        else if(near(i, i+1) && near(i, i+2)) dv[i] = med3(c, list[i+1][1], list[i+2][1]);
        else if(near(i, i-1) && near(i, i-2)) dv[i] = med3(c, list[i-1][1], list[i-2][1]);
        else dv[i] = c;
      }
      for(let i=0;i<n;i++) list[i][1] = dv[i]; }
    let k = 0;
    for(let gy=0; gy<ngy; gy++){
      const Y = gy*GY;
      while(k < list.length-1 && list[k+1][0] <= Y) k++;
      let d;
      if(Y <= list[0][0]) d = list[0][1];
      else if(k >= list.length-1) d = list[list.length-1][1];
      else { const t = (Y - list[k][0])/Math.max(1e-6, list[k+1][0] - list[k][0]); d = list[k][1]*(1-t) + list[k+1][1]*t; }
      F[gy*ngx+gx] = d;
    }
  }
  { // satır olmayan sütunlar: en yakın dolu sütundan
    let first = -1, last = -1; for(let gx=0; gx<ngx; gx++) if(has[gx]){ if(first < 0) first = gx; last = gx; }
    if(first < 0) return null;
    for(let gx=0; gx<ngx; gx++){ if(has[gx]) continue;
      let a = gx, b = gx; while(a >= 0 && !has[a]) a--; while(b < ngx && !has[b]) b++;
      const src2 = a < 0 ? b : b >= ngx ? a : (gx - a <= b - gx ? a : b);
      for(let gy=0; gy<ngy; gy++) F[gy*ngx+gx] = F[gy*ngx+src2];
    }
  }
  const Dat = (X, Y) => {
    const fx = Math.max(0, Math.min(ngx-1.001, X/GX)), fy = Math.max(0, Math.min(ngy-1.001, Y/GY));
    const ix = fx|0, iy = fy|0, tx = fx-ix, ty = fy-iy, i = iy*ngx+ix;
    return (F[i]*(1-tx) + F[i+1]*tx)*(1-ty) + (F[i+ngx]*(1-tx) + F[i+ngx+1]*tx)*ty;
  };
  let dmax = 0; for(let i=0;i<F.length;i++) dmax = Math.max(dmax, Math.abs(F[i]));
  // ---- yatay düzeltme: kenar hizaları. Sayfa kıvrıksa satır başları/sonları düz bir doğruya oturmaz
  // (sırt tarafında içe çekilir). Her kenar, satır uçlarına sağlam bir ikinci derece eğriyle uydurulur
  // ve her satır yüksekliğinde [sol eğri, sağ eğri] aralığı sabit [Lref, Rref] aralığına gerilir.
  const mr = rows.filter(r => r.main);
  const tol = pitch*0.4;
  const fitEdge = (pts, dir) => {
    const ln = txEdge(pts, tol, dir);
    if(!ln || ln.inl < 0.4 || ln.n < 3) return null;
    let ym = 0; for(const q of pts) ym += q[0]; ym /= pts.length;
    let ysd = 1; { let v = 0; for(const q of pts) v += (q[0]-ym)*(q[0]-ym); ysd = Math.sqrt(v/pts.length) || 1; }
    let c = [ln.a + ln.b*ym, ln.b*ysd, 0];
    const f = y => { const t = (y - ym)/ysd; return c[0] + c[1]*t + c[2]*t*t; };
    let nIn = ln.n;
    if(pts.length >= 8){
      for(let it=0; it<4; it++){
        const sel = pts.filter(q => Math.abs(q[1] - f(q[0])) <= pitch*0.6);
        if(sel.length < 7) break;
        const A = new Float64Array(9), B = new Float64Array(3);
        for(const q of sel){ const t = (q[0]-ym)/ysd, v = [1, t, t*t]; for(let i=0;i<3;i++){ B[i] += v[i]*q[1]; for(let j=0;j<3;j++) A[i*3+j] += v[i]*v[j]; } }
        A[8] += sel.length*0.02;                               // hafif düzenlileştirme (eğrilik)
        const sol = solveSPD(A, B, 3);
        if(!sol) break;
        // eğrinin kirişten sapması en çok ~2.5 satır aralığı
        let t0 = 1e9, t1 = -1e9; for(const q of pts){ const t = (q[0]-ym)/ysd; if(t < t0) t0 = t; if(t > t1) t1 = t; }
        if(Math.abs(sol[2])*(t1 - t0)*(t1 - t0)/4 > pitch*2.5) break;
        c = [sol[0], sol[1], sol[2]]; nIn = sel.length;
      }
    }
    // yerel artık: eğriye yakın (±0.6 satır aralığı) satır uçlarının kayan ortalaması (±3 satır) eklenir
    const near = pts.filter(q => Math.abs(q[1] - f(q[0])) <= pitch*0.6).sort((u, v) => u[0] - v[0]);
    if(near.length >= 8){
      const ys = near.map(q => q[0]), rs = near.map(q => q[1] - f(q[0])), sm = rs.map((_, i) => { let q = 0, k = 0; for(let j=Math.max(0, i-3); j<=Math.min(rs.length-1, i+3); j++){ q += rs[j]; k++; } return q/k; });
      const g = y => {
        if(y <= ys[0]) return f(y) + sm[0]; if(y >= ys[ys.length-1]) return f(y) + sm[sm.length-1];
        let lo = 0, hi = ys.length-1; while(hi - lo > 1){ const m = (lo+hi)>>1; if(ys[m] <= y) lo = m; else hi = m; }
        const t = (y - ys[lo])/Math.max(1e-6, ys[hi] - ys[lo]); return f(y) + sm[lo]*(1-t) + sm[hi]*t;
      };
      return {f: g, inl: nIn/pts.length, n: nIn, lineB: ln.b};
    }
    return {f, inl: nIn/pts.length, n: nIn, lineB: ln.b};
  };
  let eL = fitEdge(mr.map(r => [r.yref, r.X0]), -1), eR = fitEdge(mr.map(r => [r.yref, r.X1]), 1);
  const yA = mr[0].yref, yB = mr[mr.length-1].yref;
  const cl = y => Math.max(yA, Math.min(yB, y));
  const offQ = (ref, key, q) => quantile(mr.map(r => r[key] - ref(r.yref)), q);
  let Lc, Rc, stretch = true;
  if(eL && eR){ Lc = y => eL.f(cl(y)); Rc = y => eR.f(cl(y)); }
  else if(eL){ const o = offQ(eL.f, 'X1', 0.92); Lc = y => eL.f(cl(y)); Rc = y => eL.f(cl(y)) + o; stretch = false; }
  else if(eR){ const o = offQ(eR.f, 'X0', 0.08); Rc = y => eR.f(cl(y)); Lc = y => eR.f(cl(y)) + o; stretch = false; }
  else { const l0 = quantile(mr.map(r => r.X0), 0.08), r0 = quantile(mr.map(r => r.X1), 0.92); Lc = () => l0; Rc = () => r0; stretch = false; }
  const Lref = quantile(mr.map(r => Lc(r.yref)), 0.5), Rref = quantile(mr.map(r => Rc(r.yref)), 0.5);
  if(!(Rref - Lref > pitch*3)) return null;
  // (düzeltilmiş x, y) → düzlem X ve tersi
  const hx = (x, y) => { const l = Lc(y), r = Rc(y); return stretch ? l + (x - Lref)*(r - l)/(Rref - Lref) : x + (l - Lref); };
  const hxInv = (X, y) => { const l = Lc(y), r = Rc(y); return stretch ? Lref + (X - l)*(Rref - Lref)/Math.max(1, r - l) : X - (l - Lref); };
  let hmax = 0; for(const r of mr) hmax = Math.max(hmax, Math.abs(Lc(r.yref) - Lref), Math.abs(Rc(r.yref) - Rref));
  for(const r of rows){ r.X0p = r.X0; r.X1p = r.X1; r.X0 = hxInv(r.X0, r.yref); r.X1 = hxInv(r.X1, r.yref); }
  const warpF = (x, y) => { const X = hx(x, y); return [X, y + Dat(X, y)]; };
  const ink = remapGray(ink0, Wb, Hb, warpF), gray = remapGray(g0, Wb, Hb, warpF);
  TT('alan');
  const outD = remapGray(Float32Array.from(outM), Wb, Hb, warpF);
  TT('düzleştir');
  const L = {a: Lref, b: 0, inl: eL ? eL.inl : 0, n: eL ? eL.n : 0}, R = {a: Rref, b: 0, inl: eR ? eR.inl : 0, n: eR ? eR.n : 0};
  const Lf = () => Lref, Rf = () => Rref;
  // en büyük ardışık satır grubu (aradaki boşluk ≤ 3.5 satır)
  // (yalnız kenar hizasına oturan satırlar: dantel izi, ortalanmış başlık bloğa girmez; başlık sonra bant olarak eklenir)
  let gd = mr.filter(r => Math.abs(r.X0 - Lref) < pitch*1.3 || Math.abs(r.X1 - Rref) < pitch*1.3);
  if(gd.length < 3) gd = mr;
  for(const r of gd) r.good = true;
  let best = null, cur = [gd[0]];
  for(let i=1;i<gd.length;i++){
    if(gd[i].yref - gd[i-1].yref <= pitch*3.5) cur.push(gd[i]);
    else { if(!best || cur.length > best.length) best = cur; cur = [gd[i]]; }
  }
  if(!best || cur.length > best.length) best = cur;
  if(best.length < 3) return null;
  // geçerlilik: gerçek bir yazı bloğu mu? (kapak, afiş, resim üstü yazı gibi sayfalar eski yola bırakılır)
  { const gaps = []; for(let i=1;i<best.length;i++) gaps.push((best[i].yref - best[i-1].yref)/pitch);
    const reg = gaps.length ? gaps.filter(g => (g > 0.75 && g < 1.3) || (g > 1.75 && g < 2.3)).length/gaps.length : 0;
    const lens = best.map(r => (r.X1 - r.X0)/pitch), medLen = quantile(lens, 0.5);
    const inl = Math.max(eL ? eL.inl : 0, eR ? eR.inl : 0);
    if(best.length < 4 || reg < 0.6 || medLen < 5 || inl < 0.45){
      dbg.push(`yazı bloğu sayılmadı (satır ${best.length}, düzenli aralık %${(reg*100)|0}, ortanca uzunluk ${medLen.toFixed(1)} aralık, hiza ${inl.toFixed(2)})`);
      return null;
    } }
  const tb = {Lf, Rf, yTop: best[0].yref - pitch*0.65, yBot: best[best.length-1].yref + pitch*0.65, n: best.length};
  const bands = rows.map(r => ({ym: r.yref, l: r.X0, r: r.X1, main: r.main}));
  const margins = {L, R, bands, xa: Lref, xb: Rref, n: bands.length};
  const toSrc = (x, y) => { const X = hx(x, y); return applyH(hm, X, y + Dat(X, y)); };
  const srcH = (dist(qB[0],qB[3]) + dist(qB[1],qB[2]))/2;
  dbg.push('düzlem süre ' + tm.join(' '));
  dbg.push(`düzlem ${Wb}x${Hb} aralık ${pitch.toFixed(1)} pay Ü${(eyT/pv).toFixed(1)} A${(eyB/pv).toFixed(1)} satır kıvrımı ≤${dmax.toFixed(1)}px kenar eğriliği ≤${hmax.toFixed(1)}px${stretch ? '' : ' (sağ serbest)'} blok ${tb.n} satır L(inl ${L.inl.toFixed(2)}) R(inl ${R.inl.toFixed(2)})`);
  if(G.__txKeep){ G.__txAll = all.filter(r => !rows.includes(r)).map(r => ({X: r.X, Y: r.Y, X0: r.X0, X1: r.X1})); }
  if(G.__txKeep) G.__txKeep.push({g0, gray, ink, Wb, Hb, rows: rows.map(r => ({X: r.X, Y: r.Y, X0: r.X0, X1: r.X1, X0p: r.X0p, X1p: r.X1p, yref: r.yref, main: r.main})), tb: {yTop: tb.yTop, yBot: tb.yBot, L, R}, xa: Lref, xb: Rref});
  return {toSrc, bw: Wb, bh: Hb, fields: [], margins, tb, pitch, ink, gray, srcPerPx: srcH/Hb, neighborSide: [false,false,false,false],
          box: {x0:0, y0:0, x1:Wb, y1:Hb}, Wa: Wb, Ha: Hb, tx: true, rows, all, PX, PY, pv, hm, qB, outD, capT, capB};
}
/* yan sayfanın yazısı hangi tarafta? (ana bloğun sağında/solunda, düzenli satır aralıklı başka bir küme)
   Dönen 'L' (sol sayfa: komşu sağda), 'R' ya da '' */
function txSide(P, c){
  let nl = 0, nr = 0;
  const groups = new Map();
  for(const r of P.all){ if(r.main) continue; if(!groups.has(r.bi)) groups.set(r.bi, []); groups.get(r.bi).push(r); }
  const p = P.pitch, y0 = P.tb.yTop - p*3, y1 = P.tb.yBot + p*3, xa = P.margins.xa, xb = P.margins.xb;
  // sayfanın içerik alanı (başlık … sayfa no): komşu sayfanın yazısı da aşağı yukarı bu aralıktadır
  const cy0 = c ? c.y0 - p*2.5 : -1e9, cy1 = c ? c.y0 + c.h + p*2.5 : 1e9;
  const ym = r => (r.Y[0] + r.Y[r.Y.length-1])/2, len = r => Math.abs(r.X1 - r.X0);
  const amp = r => { let a = 0, n = 0; for(const q of r.row.chains){ a += q.amp*q.n; n += q.n; } return n ? a/n : 0; };
  const ampMain = quantile(P.all.filter(r => r.main).map(amp), 0.5) || 0;
  for(const g of groups.values()){
    const rs = g.filter(r => { const y = ym(r); return y > y0 && y < y1 && len(r) > p*2.5; }).sort((a, b) => a.Y[0] - b.Y[0]);
    if(rs.length < 6) continue;
    // düzenli aralık: komşu satır farklarının çoğu ana satır aralığına yakın
    let reg = 0; for(let i=1;i<rs.length;i++){ const d = (rs[i].Y[0] - rs[i-1].Y[0])/p; if(d > 0.6 && d < 1.5) reg++; }
    if(reg < (rs.length-1)*0.6) continue;
    const right = rs.filter(r => r.X0 > xb).length, left = rs.filter(r => r.X1 < xa).length;
    if(right < rs.length*0.8 && left < rs.length*0.8) continue;
    const isR = right >= rs.length*0.8;
    // Yazı mı, desen mi (dantel örtü, klavye)? Gerçek yazıda:
    //  - küme sayfanın yazı alanının çok üstüne / altına taşmaz,
    //  - satırların sırta bakan uçları düz bir kenara dizilir (komşu sayfanın kenar boşluğu),
    //  - öbür uçları da hizalıdır (karşı kenar boşluğu ya da kadraj kenarı); desende dağınıktır,
    //  - satırlar uzundur (ortanca ≥ 4 satır aralığı).
    if(g.filter(r => { const y = ym(r); return (y < cy0 || y > cy1) && len(r) > p*2.5; }).length >= 3) continue;
    const near = txEdge(rs.map(r => [ym(r), isR ? r.X0 : r.X1]), p*0.5, isR ? -1 : 1);
    if(!near || near.inl < 0.6) continue;
    const far = txEdge(rs.map(r => [ym(r), isR ? r.X1 : r.X0]), p*0.7, isR ? 1 : -1);
    if(!far || far.inl < 0.5) continue;
    if(quantile(rs.map(len), 0.5) < p*4) continue;
    //  - satır izlerinin belirginliği (genlik) sayfanın kendi yazısına yakındır; desende belirgin biçimde düşüktür,
    //  - komşu sayfadan en az 12 satır görünür.
    if(rs.length < 12 || quantile(rs.map(amp), 0.5) < ampMain*0.75) continue;
    if(isR) nr += rs.length; else nl += rs.length;
  }
  if(nr >= 6 && nr > nl*3) return 'L';
  if(nl >= 6 && nl > nr*3) return 'R';
  return '';
}

/* yarıçapı R olan kare pencerede en büyük değer (ayrılabilir, piksel başına sabit maliyet) */
function txMaxFilter(g, w, h, R){
  const k = 2*R + 1, o = new Float32Array(w*h), t = new Float32Array(w*h);
  const mx = Math.max(w, h), L = new Float32Array(mx), Rr = new Float32Array(mx);
  const run = (src, dst, n, stride, off) => {
    // 1 boyutlu: blok başından ileri (L) ve blok sonundan geri (Rr) birikimli en büyükler
    for(let i=0;i<n;i++){ const v = src[off + i*stride]; L[i] = (i % k === 0) ? v : Math.max(L[i-1], v); }
    for(let i=n-1;i>=0;i--){ const v = src[off + i*stride]; Rr[i] = (i === n-1 || (i+1) % k === 0) ? v : Math.max(Rr[i+1], v); }
    for(let i=0;i<n;i++){ const a = Math.max(0, i-R), b = Math.min(n-1, i+R); dst[off + i*stride] = Math.max(Rr[a], L[b]); }
  };
  for(let y=0;y<h;y++) run(g, t, w, 1, y*w);
  for(let x=0;x<w;x++) run(t, o, h, w, x);
  return o;
}
/* içerik kutusu (yazı düzleminde): yazı bloğu + üstünde/altında aynı sütunda, arada yalnız boş kağıt
   olan başlık, alıntı, sayfa numarası, resim.
   Mürekkep bileşenlere ayrılır: sütunun yanına taşan, düzlem kenarına değen ya da uzun-ince düşey
   izler (dantel, sayfa kenarı, koyu zemin, sırt çizgisi, parmak) "sayfa dışı"dır; bunlara ya da koyu
   zemine gelince durulur. Sayfa dışı izler çıktıda da silinir.
   Dönen: {x0, y0, w, h, pitch, cutTop, cutBot, extraTop, extraBot, env(y) → [sol, sağ], erase, ew} */
function txContent(P, dbg){
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()); let t0 = now(); const tm = [];
  const TT = n => { const t = now(); tm.push(n + ':' + Math.round(t - t0)); t0 = t; };
  const {gray, bw: w, bh: h, pitch: p, tb, rows} = P, N = w*h;
  const blk = rows.filter(r => r.main && r.yref >= tb.yTop && r.yref <= tb.yBot);
  if(blk.length < 3) return null;
  // sütun: kenar hizaları (satır uçları hizadan en çok ~1 satır aralığı taşabilir)
  let xlB = 1e9, xrB = -1e9;
  for(const r of blk){ const l = tb.Lf(r.yref), q = tb.Rf(r.yref); xlB = Math.min(xlB, r.X0 > l - p ? Math.min(r.X0, l) : l); xrB = Math.max(xrB, r.X1 < q + p ? Math.max(r.X1, q) : q); }
  xlB = Math.max(0, Math.round(xlB)); xrB = Math.min(w-1, Math.round(xrB));
  const cw = xrB - xlB + 1;
  if(cw < p*3) return null;
  // yalnız GERÇEK yazı koyuluğundaki mürekkep: arka yüzden vuran silik yazı, hafif gölge boş kağıt sayılır
  // Koyuluk yakın çevreye göre ölçülür (±0.45 satır aralığındaki en parlak değer): gölge, ışık geçişi,
  // koyu zemin "mürekkep" olmaz; yalnız ince vuruşlar (yazı, çizgi, dantel deseni) kalır.
  const strong = new Uint8Array(N);
  { const lm = txMaxFilter(gray, w, h, Math.max(3, Math.round(p*0.45)));
    const fine = new Float32Array(N); for(let i=0;i<N;i++){ const m = lm[i]; fine[i] = m > 20 ? (m - gray[i])/m : 0; }
    const vs = []; const y0 = Math.max(0, tb.yTop|0), y1 = Math.min(h, tb.yBot|0);
    for(let y=y0; y<y1; y+=3){ const r = y*w; for(let x=xlB; x<=xrB; x+=3){ const v = fine[r+x]; if(v > 0.12) vs.push(v); } }
    const thr = Math.max(0.16, (vs.length ? quantile(vs, 0.8) : 0.6)*0.5);
    for(let i=0;i<N;i++) if(fine[i] >= thr) strong[i] = 1; }
  TT('ince');
  // bileşenler → sayfa dışı izler
  const rH = Math.max(2, Math.round(p*0.3)), dil = new Uint8Array(N);
  for(let y=0;y<h;y++){ const r = y*w; let until = -1; for(let x=0;x<w;x++){ if(strong[r+x]){ const a = Math.max(until+1, x-rH); for(let k=a; k<x; k++) dil[r+k] = 1; until = Math.min(w-1, x+rH); } if(x <= until) dil[r+x] = 1; } }
  const LC = labelComponents(dil, w, h), nL = LC.count + 1;
  for(let i=0;i<N;i++) if(!strong[i]) LC.labels[i] = -LC.labels[i];          // genişletme pikselleri: etiket eksi (mürekkep değil)
  const mnx = new Int32Array(nL).fill(1e9), mxx = new Int32Array(nL).fill(-1), mny = new Int32Array(nL).fill(1e9), mxy = new Int32Array(nL).fill(-1);
  for(let y=0, i=0; y<h; y++) for(let x=0; x<w; x++, i++){ const l = Math.abs(LC.labels[i]); if(!l) continue; if(x < mnx[l]) mnx[l] = x; if(x > mxx[l]) mxx[l] = x; if(y < mny[l]) mny[l] = y; if(y > mxy[l]) mxy[l] = y; }
  const isJunk = new Uint8Array(nL), sideM = p*0.8 + rH;
  for(let l=1; l<nL; l++){
    const ww = mxx[l] - mnx[l] + 1, hh = mxy[l] - mny[l] + 1;
    if(mnx[l] < xlB - sideM || mxx[l] > xrB + sideM || mnx[l] <= 0 || mxx[l] >= w-1 || mny[l] <= 0 || mxy[l] >= h-1 || (hh > p*3.5 && ww < p*0.7 + 2*rH)) isJunk[l] = 1;
  }
  TT('bileşen');
  const junkRow = new Float32Array(h), rowMax = new Float32Array(h), rowDark = new Float32Array(h), rowOut = new Float32Array(h);
  const outD = P.outD;
  const bg = bgMapGray(gray, w, h);
  const smp = []; for(let y=Math.max(0, tb.yTop|0); y<Math.min(h, tb.yBot|0); y+=7) for(let x=xlB; x<=xrB; x+=9) smp.push(bg[y*w+x]);
  const darkT = quantile(smp, 0.5)*0.55;
  const win = Math.max(4, Math.round(p*2));
  const cl = (r, x) => { const l = LC.labels[r+x]; return l > 0 && !isJunk[l] ? 1 : 0; };
  for(let y=0;y<h;y++){
    const r = y*w; let q = 0, best = 0, jk = 0, dk = 0, nd = 0;
    for(let x=xlB; x<=xrB; x++){
      const l = LC.labels[r+x];
      if(l > 0){ if(isJunk[l]) jk++; else q++; }
      if(x - xlB >= win) q -= cl(r, x - win);
      if(q > best) best = q;
    }
    let no = 0; for(let x=xlB; x<=xrB; x+=3){ nd++; if(bg[r+x] < darkT) dk++; if(outD && outD[r+x] > 0.5) no++; }
    rowMax[y] = best/win; junkRow[y] = jk/cw; rowDark[y] = nd ? dk/nd : 0; rowOut[y] = nd ? no/nd : 0;
  }
  TT('satır');
  const rm = smooth1(rowMax, 1), jr = smooth1(junkRow, 2);
  const INK = 0.02, bands = [], lineRects = [];
  // yatay mürekkep koşularının ortalama uzunluğu: yazıda harf vuruşları kısadır (≈0.1-0.3 satır aralığı);
  // sayfa kenarı, kağıt kenarı, cetvel çizgisi gibi izlerde çok uzundur
  const meanRun = (a, b, x0, x1) => {
    let tot = 0, runs = 0;
    for(let yy=a; yy<=b; yy++){ const q = yy*w; let on = 0; for(let x=x0; x<=x1; x++){ const v = cl(q, x); if(v){ tot++; if(!on) runs++; } on = v; } }
    return runs ? tot/runs : 0;
  };
  // sütundaki gerçek yazı satırları: iz bandındaki mürekkebin çoğu temiz (sayfa dışı iz değil)
  const rowClean = r => {
    const ya = Math.max(0, Math.round(r.yref - p*0.3)), yb = Math.min(h-1, Math.round(r.yref + p*0.3)), xa2 = Math.max(0, Math.round(r.X0)), xb2 = Math.min(w-1, Math.round(r.X1));
    let c = 0, j = 0; for(let yy=ya; yy<=yb; yy++){ const q = yy*w; for(let x=xa2; x<=xb2; x+=2){ const l = LC.labels[q+x]; if(l > 0){ if(isJunk[l]) j++; else c++; } } }
    if(!(c > 8 && c >= (c + j)*0.7) || meanRun(ya, yb, xa2, xb2) > p*0.6) return false;
    // mürekkepli sütun başına kalınlık: yazıda harf gövdesi (≥0.13 satır aralığı), ince çizgide 1-2 piksel
    let n1 = 0, tot = 0; for(let x=xa2; x<=xb2; x++){ let q = 0; for(let yy=ya; yy<=yb; yy++) q += cl(yy*w, x); if(q){ n1++; tot += q; } }
    return n1 > p && tot/n1 >= p*0.13;
  };
  const colRows = rows.filter(r => r.X1 - r.X0 > p*3 && r.X0 > xlB - p*1.6 && r.X1 < xrB + p*1.6 && (r.good || rowClean(r)));
  const scan = (from, dir) => {
    let edge = from, gap = 0, y = from + dir, cut = false, why = 'boşluk', keepLast = false;
    const nb0 = bands.length;
    while(y >= 0 && y < h){
      if(rowOut[y] > 0.5){ why = 'kadraj sonu'; if(gap < p*0.8) cut = true; break; }
      if(rowDark[y] > 0.35){ why = 'koyu zemin'; break; }
      if(jr[y] > 0.12){ why = 'sayfa dışı iz'; break; }
      if(rm[y] <= INK){ gap++; if(gap > p*16){ why = 'boşluk'; break; } y += dir; continue; }
      let y2 = y, last = y; const holeMax = Math.max(2, p*0.12);
      while(y2 >= 0 && y2 < h){ if(rowOut[y2] > 0.5 || rowDark[y2] > 0.35 || jr[y2] > 0.12) break; if(rm[y2] > INK) last = y2; else if(Math.abs(y2 - last) > holeMax) break; y2 += dir; }
      y2 = last + dir;                                   // bandın uzak ucu (dahil değil)
      const a = Math.min(y, last), b = Math.max(y, last), hgt = b - a + 1;
      // bant yatayda parçalara ayrılır (aralarında > 1.5 satır aralığı boşluk): aynı satırlara düşen
      // sayfa kenarı çizgisi ile sayfa numarası gibi ayrı öğeler ayrı ayrı değerlendirilir
      const cthr = Math.max(0.5, hgt*0.06), segs = [];
      { let s0 = -1, lastX = -1e9;
        for(let x=xlB; x<=xrB+1; x++){
          let q = 0; if(x <= xrB) for(let yy=a; yy<=b; yy++) q += cl(yy*w, x);
          if(q > cthr){ if(s0 < 0) s0 = x; else if(x - lastX > p*1.5){ segs.push([s0, lastX]); s0 = x; } lastX = x; }
        }
        if(s0 >= 0) segs.push([s0, lastX]); }
      if(!segs.length){ gap += hgt; y = y2; continue; }
      const acc = []; let bad = '';
      for(const sg of segs){
        let sa = -1, sb = -1, ar = 0;
        for(let yy=a; yy<=b; yy++){ let q = 0; const r = yy*w; for(let x=sg[0]; x<=sg[1]; x++) q += cl(r, x); if(q){ if(sa < 0) sa = yy; sb = yy; ar += q; } }
        if(sa < 0) continue;
        const sh = sb - sa + 1, wid = sg[1] - sg[0] + 1, fill = ar/(sh*wid);
        const ja = Math.max(xlB, Math.round(sg[0] - p*2)), jb = Math.min(xrB, Math.round(sg[1] + p*2));
        let jm = 0; for(let yy=sa; yy<=sb; yy++){ const r = yy*w; for(let x=ja; x<=jb; x++){ const l = LC.labels[r+x]; if(l > 0 && isJunk[l]) jm++; } }
        jm /= sh*(jb - ja + 1);
        const mr = wid > p*1.5 ? meanRun(sa, sb, sg[0], sg[1]) : 0;
        let kind = 'yazı';
        if((wid > p*1.5 && mr > p*0.6) || (wid > cw*0.4 && (sh < p*0.2 || fill < 0.05))) kind = 'çizgi (sayfa kenarı)';
        else if(sh < p*0.2 || wid < p*0.15) kind = 'leke';
        else if(jm > 0.03) kind = 'sayfa dışı iz';
        else if(sh > p*2.3) kind = 'yazı olmayan bant';
        if(G.__txBand) G.__txBand.push(`${dir<0?'↑':'↓'} ${sa}-${sb} h=${(sh/p).toFixed(2)}p x=${sg[0]}-${sg[1]} dolu=${fill.toFixed(2)} iz=${jm.toFixed(3)} koşu=${(mr/p).toFixed(2)}p boşluk=${(gap/p).toFixed(1)}p → ${kind}`);
        if(kind === 'yazı') acc.push({a: sa, b: sb, x0: sg[0], x1: sg[1]});
        else if(kind !== 'leke'){ if(!bad || bad.startsWith('çizgi')) bad = kind; if(kind.startsWith('çizgi')) lineRects.push({a: sa, b: sb, x0: sg[0], x1: sg[1]}); }
      }
      // dantel / koyu zemin parçası içeren bant bütünüyle sayfa dışıdır; yalnız sayfa kenarı ÇİZGİSİ ile aynı
      // satırlara düşen yazı (ör. sayfa numarası) alınır
      if(bad && !bad.startsWith('çizgi')){ why = bad; break; }
      if(!acc.length){
        if(bad){ why = bad; break; }
        gap += hgt; y = y2; continue;                    // yalnız küçük lekeler: yok say
      }
      const band = {a: Math.min(...acc.map(q => q.a)), b: Math.max(...acc.map(q => q.b)), x0: Math.min(...acc.map(q => q.x0)), x1: Math.max(...acc.map(q => q.x1))};
      bands.push(band);
      edge = dir < 0 ? band.a : band.b;
      const bwid = band.x1 - band.x0 + 1, bh = band.b - band.a + 1;
      // aynı satırlarda sayfa kenarı / sayfa dışı iz de vardı: yazı alınır, ötesine geçilmez
      if(bad){ why = bad; keepLast = true; gap = 0; break; }
      // sayfa numarası / üst başlık gibi küçük, ayrık işaret ve ötesinde yazı satırı yok: sayfanın en dış öğesi → dur
      const small = bwid < p*2.6 && bh < p*1.3 && gap >= p*0.8;
      gap = 0;
      if(small){
        const beyond = colRows.filter(r => dir < 0 ? (r.yref < band.a - p*0.5 && r.yref > band.a - p*14) : (r.yref > band.b + p*0.5 && r.yref < band.b + p*14));
        if(beyond.length < 2){ why = 'sayfa no / başlık'; break; }
      }
      y = y2;
    }
    if(y < 0 || y >= h){ why = 'düzlem sonu'; if(gap < p*0.8 && !(dir < 0 ? P.capT : P.capB)) cut = true; }
    if(!keepLast && why !== 'sayfa no / başlık' && why !== 'boşluk' && gap < p*0.5 && bands.length > nb0){
      const q = bands[bands.length-1];
      // yazı satırı içeren bant atılmaz (kadrajın kestiği gerçek yazı: 'kesik' olarak işaretli kalır)
      if(!colRows.some(r => r.yref >= q.a && r.yref <= q.b)){
        bands.pop(); cut = false;
        edge = bands.length > nb0 ? (dir < 0 ? bands[bands.length-1].a : bands[bands.length-1].b) : from;
        why += ' (yapışık bant atıldı)';
      }
    }
    return {edge, cut, why, gap};
  };
  const yT0 = Math.max(0, Math.round(tb.yTop)), yB0 = Math.min(h-1, Math.round(tb.yBot));
  const up = scan(yT0, -1), dn = scan(yB0, 1);
  TT('tara');
  const Y0 = Math.max(0, Math.round(up.edge - p*0.6)), Y1 = Math.min(h, Math.round(dn.edge + p*0.6));
  const inBand = y => { if(y >= tb.yTop && y <= tb.yBot) return true; for(const b of bands) if(y >= b.a - p*0.3 && y <= b.b + p*0.3) return true; return false; };
  // yatay kapsam ve zarf: kutudaki satırlar + bantlar
  const items = [];
  const hb = Math.max(1, Math.round(p*0.45));
  for(const r of rows){
    if(r.yref < Y0 || r.yref > Y1 || !inBand(r.yref)) continue;
    if(r.X0 < xlB - p*1.6 || r.X1 > xrB + p*1.6) continue;
    let l = r.X0, q = r.X1;
    const ya = Math.max(0, Math.round(r.yref) - hb), yb = Math.min(h-1, Math.round(r.yref) + hb), ct = Math.max(1, hb*0.25);
    for(let x=xlB; x<l; x++){ let c = 0; for(let yy=ya; yy<=yb; yy++) c += cl(yy*w, x); if(c > ct){ l = x; break; } }
    for(let x=xrB; x>q; x--){ let c = 0; for(let yy=ya; yy<=yb; yy++) c += cl(yy*w, x); if(c > ct){ q = x; break; } }
    items.push({y: r.yref, l, r: q});
  }
  for(const b of bands) items.push({y: (b.a + b.b)/2, l: b.x0, r: b.x1, hh: (b.b - b.a)/2});
  items.sort((u, v) => u.y - v.y);
  if(!items.length) return null;
  const n = items.length, eL = new Float32Array(n), eR = new Float32Array(n);
  for(let i=0;i<n;i++){ eL[i] = items[i].l; eR[i] = items[i].r; }
  // zarf: y'ye en yakın öğelerin (±0.8 satır aralığı + öğenin yarı yüksekliği) kapsamı; arada kalan yerde komşuların birleşimi
  const env = y => {
    let l = 1e9, r = -1e9, lo = 0, hi = n-1;
    while(hi - lo > 1){ const m = (lo+hi)>>1; if(items[m].y <= y) lo = m; else hi = m; }
    for(let i=Math.max(0, lo-3); i<=Math.min(n-1, hi+3); i++){ const d = Math.abs(items[i].y - y) - (items[i].hh || 0); if(d <= p*0.8){ if(eL[i] < l) l = eL[i]; if(eR[i] > r) r = eR[i]; } }
    if(r < l){ const a = items[lo], b = items[hi]; l = Math.min(a.l, b.l); r = Math.max(a.r, b.r); }
    return [l, r];
  };
  let xl = 1e9, xr = -1e9; for(let i=0;i<n;i++){ if(eL[i] < xl) xl = eL[i]; if(eR[i] > xr) xr = eR[i]; }
  const padX = p*0.55;
  const x0 = Math.max(0, Math.floor(xl - padX)), x1 = Math.min(w, Math.ceil(xr + padX));
  // çıktıda silinecek sayfa dışı izler (satır bantlarının içindekiler korunur), 2 px genişletilmiş
  const prot = new Uint8Array(N);
  for(const r of rows){ if(!(r.X1 > r.X0) || !inBand(r.yref)) continue; const ya = Math.max(0, Math.round(r.yref - p*0.5)), yb = Math.min(h-1, Math.round(r.yref + p*0.5)), xa2 = Math.max(0, Math.round(r.X0 - 2)), xb2 = Math.min(w-1, Math.round(r.X1 + 2));
    if(r.X0 < xlB - p*1.6 || r.X1 > xrB + p*1.6) continue;
    for(let y=ya; y<=yb; y++) prot.fill(1, y*w + xa2, y*w + xb2 + 1); }
  let er = new Uint8Array(N), nEr = 0;
  for(let y=Y0; y<Y1; y++){ const r = y*w; for(let x=x0; x<x1; x++){ const l = LC.labels[r+x]; if(l > 0 && isJunk[l] && !prot[r+x]){ er[r+x] = 1; nEr++; } } }
  for(const q of lineRects) for(let y=Math.max(Y0, q.a - 1); y<=Math.min(Y1 - 1, q.b + 1); y++){ const r = y*w; for(let x=Math.max(x0, q.x0 - 1); x<=Math.min(x1 - 1, q.x1 + 1); x++) if(LC.labels[r+x] > 0 && !prot[r+x]){ er[r+x] = 1; nEr++; } }
  if(nEr){ er = dilate1(dilate1(er, w, h), w, h); for(let i=0;i<N;i++) if(prot[i]) er[i] = 0; }
  TT('zarf');
  let occl = 0;
  { const xi0 = Math.round(xlB + p*1.2), xi1 = Math.round(xrB - p*1.2), minRun = Math.round(p*1.5);
    if(xi1 - xi0 > minRun) for(const r of blk){
      const y = Math.max(0, Math.min(h-1, Math.round(r.yref))), row = y*w, vs = [];
      for(let x=xi0; x<=xi1; x+=2) vs.push(bg[row+x]);
      const ref = quantile(vs, 0.8)*0.68; let run = 0;
      for(let x=xi0; x<=xi1+1; x++){ if(x <= xi1 && bg[row+x] < ref) run++; else { if(run >= minRun) occl += run/p; run = 0; } }
    } }
  TT('son'); dbg.push('içerik süre ' + tm.join(' '));
  dbg.push(`içerik ${x0}-${x1} × ${Y0}-${Y1} (blok ${tb.yTop|0}-${tb.yBot|0}) üst:${up.why}${up.cut ? ' KESİK' : ''} alt:${dn.why}${dn.cut ? ' KESİK' : ''} bant ${bands.length}${nEr ? ' silinen iz ' + nEr + 'px' : ''}${occl ? ' örtülü ' + occl.toFixed(1) : ''}`);
  return {x0, y0: Y0, w: x1 - x0, h: Y1 - Y0, pitch: p, cutTop: up.cut, cutBot: dn.cut,
          extraTop: (tb.yTop - up.edge)/p, extraBot: (dn.edge - tb.yBot)/p, env, envPad: p*0.75, erase: nEr ? er : null, ew: w, eh: h, occl};
}
/* ==TX-END== */
function processCanvas(src, opts){
  const t0 = Date.now();
  // hızlı kontrol (canlı çekimde 'bip' kararı): küçük kaynak, küçük düzlemler, çıktı yok
  const quick = !!opts.quick;
  let qScale = 1;
  if(quick){
    qScale = Math.min(1, 1120/Math.max(src.width, src.height));
    if(qScale < 1) src = downscale(src, Math.round(src.width*qScale), Math.round(src.height*qScale));
  }
  const W = src.width, H = src.height;
  const outW = (opts.outW || 1240)*(quick ? 0.5 : 1)|0, outH = (opts.outH || 1754)*(quick ? 0.5 : 1)|0;
  const issues = [], dbg = [];
  let tl = Date.now(); const tms = [];
  const T = name => { const n=Date.now(); tms.push(name+':'+(n-tl)); tl=n; };
  const sd = imgData(src).data;
  let det = null, quad = null;
  // ---- yazı öncelikli yol: yazı satırlarından yön, perspektif ve kıvrım (sayfa kenarına bakmaz)
  let TX = null;
  if(opts.smartCrop && opts.tx !== false){
    try{
      const f = txFind(src, {sd, maxSide: quick ? 760 : 1100, quick, angHint: opts.angHint});
      for(const d of f.dbg) dbg.push(d);
      if(f.ok){
        const Pn = txPlane(sd, W, H, f, quick, dbg);
        if(Pn){ const c = txContent(Pn, dbg); if(c && c.w > 8 && c.h > 8) TX = {P: Pn, content: c, tq: f.quad, f, ang: f.st.ang}; }
      }
    }catch(e){ dbg.push('yazı yolu hata: ' + (e && e.message)); }
    T('yazı');
  }
  if(opts.smartCrop && !opts.noDet && !TX){
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
  const A = TX ? {tb: null, ink: null, margins: null, neighborSide: [false,false,false,false], bw: 1, bh: 1, pitch: 0, srcPerPx: 1, toSrc: (x, y) => [x, y]}
               : analyzePlane(sd, W, H, quad, arA, HaA, opts.smartCrop, opts.smartCrop && opts.dewarp !== false, dbg, 'A');
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
  if(TX){ P = TX.P; content = TX.content; tqSrc = TX.tq; }
  // ---- son eşleme: çıktı pikseli → kaynak
  let mapOut, srcSpanH, mode;
  if(content){
    mode = 'yazı';
    const c = content;
    const hmap = P.tx ? null : marginMap(P);
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
    const sTx = TX ? txSide(TX.P, TX.content) : '';
    side = sTx ? {side: sTx, why: 'komşu sayfanın yazısı'} : sideCues(sd, W, H, tqSrc);
  }
  if(mode === 'yazı'){
    // içeriğin her yanında kadrajın kaç satır aralığı daha gördüğü (sayfa no, başlık için).
    // Yazı yolunda ölçü YAZININ KENDİ SINIRINDAN alınır (satır uçlarının zarfı), kutunun köşelerinden değil:
    // eğik tutulan sayfada kutunun boş köşesi kadraj dışına düşse de yazı tamdır.
    const tolR = 0.004*Math.min(W,H), pc = content.pitch || 20;
    const inside = p => isFinite(p[0]) && isFinite(p[1]) && p[0] >= tolR && p[1] >= tolR && p[0] <= W-1-tolR && p[1] <= H-1-tolR;
    const envX = content.env ? (y => { const e = content.env(content.y0 + y); return [e[0] - content.x0, e[1] - content.x0]; }) : null;
    const sideIn = (e, k) => {
      const off = k*pc;
      for(let t=0.03; t<=0.98; t+=0.0475){
        let x, y;
        if(envX){
          if(e === 0 || e === 2){
            const q = envX(e === 0 ? Math.min(content.h, pc*0.9) : Math.max(0, content.h - pc*0.9));
            x = q[0] + t*(q[1] - q[0]); y = e === 0 ? -off : content.h + off;
          } else {
            y = t*content.h; const q = envX(y);
            x = e === 1 ? q[1] + pc*0.35 + off : q[0] - pc*0.35 - off;
          }
        } else if(e === 0){ x = t*content.w; y = -off; } else if(e === 1){ x = content.w + off; y = t*content.h; }
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
  // hızlı kontrolde (yazı yolu) çıktı sayfası üretilmez: netlik ölçüsü için yalnız ortadaki şerit örneklenir
  const vOff = quick && TX ? Math.round(fh*0.3) : 0, fhR = quick && TX ? Math.max(16, Math.min(fh - vOff, Math.round(fh*0.4))) : fh;
  const grid = buildGrid(fw, fhR, 8, (u, v) => mapOut(u/s, (v + vOff)/s));
  const mag = fh / Math.max(1, srcSpanH);
  const pageData = remap(sd, W, H, fw, fhR, grid, mag > 1.15, mode === 'yazı' ? [255,255,255] : null);
  T('örnekle');

  // ---- parmak / sayfa dışı (1/4 çözünürlük)
  const Q = 4, qw = Math.ceil(fw/Q), qh = Math.ceil(fhR/Q);
  const qRaw = TX ? null : shrinkRGB(pageData, fw, fhR, Q);
  const paperRaw = TX ? [255, 255, 255] : paperColorQ(qRaw, qw*qh);
  const paperL = 0.299*paperRaw[0]+0.587*paperRaw[1]+0.114*paperRaw[2];
  let fillQ = null, fingerQ = null;
  if(opts.smartCrop && !TX){
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
  enhanceRGBA(pageData, fw, fhR, opts.mode);
  if(fillQ){
    let m = dilate1(fillQ, qw, qh);
    if(fingerQ) for(let k=0;k<2;k++) m = dilate1(m, qw, qh);
    const a = new Float32Array(qw*qh); for(let i=0;i<qw*qh;i++) a[i]=m[i];
    const alpha = boxBlur(a, qw, qh, 1, 1);
    for(let i=0;i<qw*qh;i++) alpha[i] = Math.min(1, alpha[i]*1.5);
    fillAlphaQ(pageData, fw, fh, alpha, qw, qh, Q, paperColor(pageData, fw, fh));
  }
  if(mode === 'yazı' && content.env){
    // satır uçlarının zarfı dışında kalan her şey (sırt gölgesi, sayfa kenarı, dantel) kağıt rengine boyanır
    const pc = opts.mode === 'orig' ? paperColor(pageData, fw, fhR) : [255, 255, 255];
    const pad = content.envPad*s, fade = Math.max(2, content.pitch*0.3*s);
    for(let v=0; v<fhR; v++){
      const e = content.env(content.y0 + (v + vOff)/s);
      const xl = (e[0] - content.x0)*s - pad, xr = (e[1] - content.x0)*s + pad;
      const o = v*fw*4;
      const er = content.erase, ey = er ? Math.min(content.eh-1, Math.max(0, Math.round(content.y0 + (v + vOff)/s)))*content.ew : 0;
      for(let u=0; u<fw; u++){
        const d = u < xl ? xl - u : u > xr ? u - xr : 0;
        let a = d >= fade ? 1 : d/fade;
        if(d <= 0){
          if(!er || !er[ey + Math.min(content.ew-1, Math.round(content.x0 + u/s))]) continue;
          a = 1;
        }
        const j = o + u*4;
        pageData[j] += (pc[0] - pageData[j])*a; pageData[j+1] += (pc[1] - pageData[j+1])*a; pageData[j+2] += (pc[2] - pageData[j+2])*a;
      }
    }
  }
  T('iyileştir');
  const pageCanvas = quick ? null : putRGBA(pageData, fw, fh);
  let fbox = {x0:0,y0:0,x1:fw,y1:fhR};
  if(mode === 'sayfa' && opts.smartCrop && opts.mode !== 'orig') fbox = trimEnhancedBox(pageData, fw, fh);

  // ---- sorunlar
  const st = inkStatsQ(pageData, fw, fhR, Q, fbox, fingerQ);
  if(mode === 'yazı'){
    // içerik kutusu kenarları kaynak karede kadraj kenarına değiyor/taşıyorsa → kesik
    const tolF = 0.012*Math.min(W,H);
    const near = (p) => p[0] < tolF || p[1] < tolF || p[0] > W-1-tolF || p[1] > H-1-tolF;
    const sides = [[0,0,1,0],[1,0,1,1],[0,1,1,1],[0,0,0,1]];      // üst, sağ, alt, sol
    if(fhR === fh) sides.forEach(([ax,ay,bx,by], e) => {
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
  if(!TX && st.fingerOnText > 0.002) issues.push({code:'finger', side:-1});
  T('analiz');
  // satır genişliği / satır aralığı: çevrilmekte olan (yandan görülen) sayfada belirgin biçimde küçülür
  const cpl = tqSrc && content.pitch ? ((dist(tqSrc[0],tqSrc[1]) + dist(tqSrc[3],tqSrc[2]))/2)/Math.max(1e-6, content.pitch*(mode === 'yazı' ? P : A).srcPerPx) : 0;
  if(quick){
    const metricsQ = {sharp: st.sharp, crisp: st.crisp, inkFrac: st.frac, ms: Date.now()-t0, mode, quick: true,
                      lines: (mode === 'yazı' ? P : A).tb ? (mode === 'yazı' ? P : A).tb.n : 0, tilt, room, side: side.side,
                      srcPitch: content.pitch ? content.pitch*(mode === 'yazı' ? P : A).srcPerPx/qScale : 0,
                      extraTop: content.extraTop || 0, extraBot: content.extraBot || 0, pageCut, leftover,
                      quadN: tqSrc ? tqSrc.map(q => [q[0]/W, q[1]/H]) : null, ang: TX ? TX.ang : null, cpl};
    dbg.push(tms.join(' ')); dbg.push(`hızlı ${W}x${H}, ${metricsQ.ms} ms`);
    return {canvas: null, issues, metrics: metricsQ, dbg: dbg.join(' | '), lineSig: mode === 'yazı' ? lineSigs(P) : null};
  }
  const PP = mode === 'yazı' ? P : A;
  const metrics = {sharp: st.sharp, crisp: st.crisp, inkFrac: st.frac, ms: 0, mode,
                   lines: PP && PP.tb ? PP.tb.n : 0, tilt, room, side: side.side,
                   srcPitch: content.pitch && PP ? content.pitch*PP.srcPerPx/qScale : 0,
                   extraTop: content.extraTop || 0, extraBot: content.extraBot || 0, pageCut, leftover,
                      quadN: tqSrc ? tqSrc.map(q => [q[0]/W, q[1]/H]) : null, ang: TX ? TX.ang : null, cpl};

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
  txFind, txOrient, txWarp, txTrace, txBlocks, inkOf,
  rotateCanvas, estimateTextField, estimateAspect, homography, applyH, inQuad,
};
})(typeof self !== 'undefined' ? self : this);
