import UIKit
import QuickLook
import CoreML
import AVFoundation
import Vision
import CoreImage
import AudioToolbox
import Capacitor
import PhotosUI
import VisionKit
import UniformTypeIdentifiers

/// tanı kaydı (Mac'e bağlıyken konsolda görünür)
func nlog(_ s: String) { print("[yerel] " + s); fflush(stdout) }

/// Capacitor köprüsü: yerel eklentiyi (NativeScanner) kaydeder
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeScannerPlugin())
        // iki parmakla sayfa büyütme kapalı (büyütülen ekran geri küçültülemiyordu); ekran hep normal boyutta
        if let sv = webView?.scrollView {
            sv.minimumZoomScale = 1; sv.maximumZoomScale = 1; sv.bouncesZoom = false
            sv.pinchGestureRecognizer?.isEnabled = false
        }
        // sayfa düzleştirme modeli açılışta arka planda yüklenir (ilk yükleme ~10 sn; taramaya hazır olsun)
        DispatchQueue.global(qos: .utility).async {
            _ = PageFlattener.ready
            // metin tanıma (doğru mod) modelini de yükle: yön bulma ve OCR'ın ilk çağrısı beklemesin
            if let cg = CIContext().createCGImage(CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 64, height: 64)), from: CGRect(x: 0, y: 0, width: 64, height: 64)) { _ = PageFlattener.uprightOrientation(cg) }
        }
    }
}

/// JS: Capacitor.nativePromise('NativeScanner', 'scan', {strings}) → {pages: [{path, quad:[[x,y]×4]}]}
/// Canlı tarama ekranı: her karede Apple'ın cihazdaki belge modeli (Vision, Neural Engine) sayfanın dört köşesini
/// bulur; sayfa sabit ve dört köşesi kadrajdaysa tam çözünürlükte fotoğraf çekilir. Kırpma, düzleştirme, metin
/// tanıma ve PDF web uygulamasında (core.js) yapılır; köşeler ona ipucu (pageHint) olarak gider.
@objc(NativeScannerPlugin)
public class NativeScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeScannerPlugin"
    public let jsName = "NativeScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "record", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ocr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appleScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preview", returnType: CAPPluginReturnPromise)
    ]
    private var previewSource: PdfPreviewSource?

    /// PDF'i tam ekran göster (Apple Quick Look): kaydırarak bakılır, sağ üstte paylaş / Dosyalara kaydet, "Bitti" ile geri dönülür
    @objc func preview(_ call: CAPPluginCall) {
        guard let p = call.getString("path") else { call.reject("yol yok"); return }
        let url = p.hasPrefix("file:") ? URL(string: p)! : URL(fileURLWithPath: p)
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("görünüm yok"); return }
            let src = PdfPreviewSource(url: url) { self.previewSource = nil; call.resolve() }
            self.previewSource = src
            let ql = QLPreviewController()
            ql.dataSource = src; ql.delegate = src
            ql.modalPresentationStyle = .fullScreen
            host.present(ql, animated: true)
        }
    }

    /// Tarayıcı açıkken iOS bellek için web görünümünü kapatabilir (sayfa yeniden yüklenir, bekleyen çağrı kaybolur).
    /// Bu yüzden tarama sonucu önce diske yazılır; web görünümü açılışta / sonuç gelince bekleyenleri alır.
    static var pendingURL: URL { FileManager.default.temporaryDirectory.appendingPathComponent("bekleyen-sayfalar.json") }
    static func savePending(_ pages: [[String: Any]]) {
        guard !pages.isEmpty, let d = try? JSONSerialization.data(withJSONObject: pages) else { return }
        try? d.write(to: pendingURL)
    }
    @objc func takePending(_ call: CAPPluginCall) {
        let url = Self.pendingURL
        guard let d = try? Data(contentsOf: url), let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { call.resolve(["pages": []]); return }
        try? FileManager.default.removeItem(at: url)
        nlog("bekleyen \(arr.count) sayfa web'e verildi")
        call.resolve(["pages": arr])
    }
    private var appleScanner: AppleScanDelegate?

    /// Apple'ın belge tarayıcısı (VisionKit — Notlar / Dosyalar'daki tarayıcı): otomatik çekim, köşe, perspektif ve ışık
    /// düzeltmesi Apple'da; sayfalar düzleştirilmiş JPEG olarak döner → {pages:[{path, flat:true}], log}
    @objc func appleScan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard VNDocumentCameraViewController.isSupported, let host = self.bridge?.viewController else { call.reject("unsupported"); return }
            let t0 = CACurrentMediaTime()
            let d = AppleScanDelegate(strings: call.getObject("strings") as? [String: String] ?? [:]) { pages in
                Self.savePending(pages)
                let n = pages.count, secs = CACurrentMediaTime() - t0
                call.resolve(["pages": pages, "log": [String(format: "Apple tarayıcı: %d sayfa, %.1f sn", n, secs)]])
                self.appleScanner = nil
            }
            self.appleScanner = d
            let vc = VNDocumentCameraViewController()
            vc.delegate = d
            host.present(vc, animated: true)
        }
    }
    private let ocrQueue = DispatchQueue(label: "ns.ocr", qos: .utility)

    /// Apple metin tanıma: {path, langs} → {w, h, words:[[x0,y0,x1,y1,metin,null]], paras, ms}
    @objc func ocr(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let url = URL(string: path) ?? URL(fileURLWithPath: path) as URL? else { call.reject("path"); return }
        let langs = call.getArray("langs", String.self) ?? []
        ocrQueue.async {
            let r = PageText.recognize(url.isFileURL ? url : URL(fileURLWithPath: path), langs: langs)
            if let e = r["error"] as? String { call.reject(e) } else { call.resolve(r) }
        }
    }
    private var importer: MediaImporter?

    /// galeriden fotoğraf / video seç → yerelde incele → {pages}
    @objc func pick(_ call: CAPPluginCall) {
        let strings = call.getObject("strings") as? [String: String] ?? [:]
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("no view controller"); return }
            let imp = MediaImporter(host: host, strings: strings) { pages, log in Self.savePending(pages); call.resolve(["pages": pages, "log": log]); self.importer = nil }
            self.importer = imp
            imp.pickFromLibrary()
        }
    }
    /// telefonun kamerasıyla video kaydet → yerelde incele → {pages}
    @objc func record(_ call: CAPPluginCall) {
        let strings = call.getObject("strings") as? [String: String] ?? [:]
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("no view controller"); return }
            let imp = MediaImporter(host: host, strings: strings) { pages, log in Self.savePending(pages); call.resolve(["pages": pages, "log": log]); self.importer = nil }
            self.importer = imp
            imp.recordVideo()
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        let strings = call.getObject("strings") as? [String: String] ?? [:]
        let start = {
            DispatchQueue.main.async {
                guard let host = self.bridge?.viewController else { call.reject("no view controller"); return }
                let vc = LiveScannerViewController()
                vc.strings = strings
                vc.modalPresentationStyle = .fullScreen
                vc.onFinish = { pages, log in
                    Self.savePending(pages)
                    vc.dismiss(animated: true)
                    call.resolve(["pages": pages, "log": log])
                }
                host.present(vc, animated: true)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in ok ? start() : call.reject("camera denied") }
        default: call.reject("camera denied")
        }
    }
}


/// Y düzleminden 24×32 küçük resim: her hücre 4×4 örneğin ortalaması (tek piksel örnekleme titremede çok gürültülü)
func lumaThumb(_ pb: CVPixelBuffer) -> [UInt8] {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard CVPixelBufferGetPlaneCount(pb) > 0, let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return [UInt8](repeating: 0, count: 768) }
    let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0), bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    let p = base.assumingMemoryBound(to: UInt8.self)
    var t = [UInt8](repeating: 0, count: 24 * 32)
    for cy in 0..<32 { for cx in 0..<24 {
        var s = 0
        for sy in 0..<4 { for sx in 0..<4 {
            let x = (cx * 4 + sx) * w / 96 + w / 192, y = (cy * 4 + sy) * h / 128 + h / 256
            s += Int(p[y * bpr + x])
        } }
        t[cy * 24 + cx] = UInt8(s / 16)
    } }
    return t
}
/// iki küçük resim arasındaki fark: ±1 hücre kaydırmada en küçük ortalama mutlak fark (el titremesi elenir)
func thumbMotion(_ a: [UInt8], _ b: [UInt8]) -> Double {
    var best = 1e9
    for dy in -1...1 { for dx in -1...1 {
        var s = 0, n = 0
        for y in max(0, dy)..<(32 + min(0, dy)) { for x in max(0, dx)..<(24 + min(0, dx)) {
            s += abs(Int(a[y * 24 + x]) - Int(b[(y - dy) * 24 + x - dx])); n += 1
        } }
        if n > 0 { best = min(best, Double(s) / Double(n)) }
    } }
    return best
}

/// Normalleştirilmiş dörtgen (dik görüntü, sol-üst orijin, 0…1): sol-üst, sağ-üst, sağ-alt, sol-alt
struct PageQuad {
    var p: [CGPoint]
    init(_ o: VNRectangleObservation) {
        p = [o.topLeft, o.topRight, o.bottomRight, o.bottomLeft].map { CGPoint(x: $0.x, y: 1 - $0.y) }
    }
    func maxDist(_ o: PageQuad) -> CGFloat { zip(p, o.p).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 1 }
    func inside(_ m: CGFloat) -> Bool { p.allSatisfy { $0.x > m && $0.y > m && $0.x < 1 - m && $0.y < 1 - m } }
    var area: CGFloat {
        var s: CGFloat = 0
        for i in 0..<4 { let a = p[i], b = p[(i + 1) % 4]; s += a.x * b.y - b.x * a.y }
        return abs(s) / 2
    }
    var json: [[Double]] { p.map { [Double($0.x), Double($0.y)] } }
}

final class LiveScannerViewController: UIViewController, AVCaptureVideoDataOutputSampleBufferDelegate, AVCapturePhotoCaptureDelegate {
    var onFinish: (([[String: Any]], [String]) -> Void)?
    var strings: [String: String] = [:]
    private func S(_ k: String, _ d: String) -> String { strings[k] ?? d }

    private let session = AVCaptureSession()
    private let videoOut = AVCaptureVideoDataOutput()
    private let photoOut = AVCapturePhotoOutput()
    private let videoQueue = DispatchQueue(label: "ns.video", qos: .userInitiated)
    private let procQueue = DispatchQueue(label: "ns.proc", qos: .userInitiated)
    private static let ci = CIContext(options: [.cacheIntermediates: false])
    private var preview: AVCaptureVideoPreviewLayer?
    private let quadLayer = CAShapeLayer()
    private let hint = UILabel(), counter = UILabel()
    private let thumb = UIImageView()
    private let doneBtn = UIButton(type: .system)

    // videoQueue durumu
    private enum Phase { case hunting, capturing, waitChange }
    private var phase: Phase = .hunting
    private var history: [(t: CFTimeInterval, q: PageQuad)] = []
    private var lastSeen: CFTimeInterval = 0
    private var bufSize = CGSize(width: 3, height: 4)
    private var lastSig: [Float]? = nil
    private var capQuad: PageQuad? = nil
    private var disturbed = false
    private var visionMs: Double = 0
    private var t0 = CACurrentMediaTime()
    private var visibleSince: CFTimeInterval = 0
    private var prevThumb: [UInt8]? = nil
    private var motion: Double = 0          // kareler arası ortalama parlaklık farkı (0-255)
    private var waitSince: CFTimeInterval = 0
    private var forceShot = false           // ekrana dokunuldu: o anki sayfa hemen çekilir
    private var lastWords = Set<String>()   // son çekilen sayfanın kelimeleri (Apple metin tanıma)
    private var lastTextCheck: CFTimeInterval = 0
    private var newPageAt: CFTimeInterval = 0
    private var outSince: CFTimeInterval = 0

    // ana iş parçacığı
    /// her çekim bir grup: tek sayfa ya da açık kitabın iki sayfası + kelimeleri (aynı sayfa ikinci kez çekildi mi)
    private var caps: [(pages: [[String: Any]], words: Set<String>)] = []
    private var pages: [[String: Any]] { caps.flatMap { $0.pages } }
    private var log: [String] = []
    private var pending = 0
    private var finishing = false
    private var stopShooting = false      // "Bitti"ye basıldı: kamera yeni sayfa çekmez (bekleme hiç bitmiyordu)
    private var dispQuad: PageQuad? = nil

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupUI()
        configureSession()
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        quadLayer.frame = view.bounds
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        t0 = CACurrentMediaTime()
        UIApplication.shared.isIdleTimerDisabled = true
        videoQueue.async { if !self.session.isRunning { self.session.startRunning() } }
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        videoQueue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    // MARK: arayüz
    private func setupUI() {
        quadLayer.lineWidth = 3
        quadLayer.lineJoin = .round
        for l in [hint, counter] {
            l.translatesAutoresizingMaskIntoConstraints = false
            l.textAlignment = .center
            l.numberOfLines = 0
            view.addSubview(l)
        }
        hint.font = .systemFont(ofSize: 17, weight: .semibold)
        hint.textColor = .white
        hint.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        hint.layer.cornerRadius = 14; hint.clipsToBounds = true
        counter.font = .systemFont(ofSize: 15, weight: .bold)
        counter.textColor = .white
        setHint(S("show", "Sayfayı göster — kendiliğinden çekilir"))
        counter.text = S("count", "{n} sayfa").replacingOccurrences(of: "{n}", with: "0")

        doneBtn.setTitle(S("done", "Bitti ✓"), for: .normal)
        doneBtn.titleLabel?.font = .systemFont(ofSize: 18, weight: .bold)
        doneBtn.backgroundColor = UIColor(red: 0.18, green: 0.88, blue: 0.69, alpha: 1)
        doneBtn.setTitleColor(.black, for: .normal)
        doneBtn.layer.cornerRadius = 23
        doneBtn.translatesAutoresizingMaskIntoConstraints = false
        doneBtn.addTarget(self, action: #selector(finish), for: .touchUpInside)
        view.addSubview(doneBtn)

        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapShot)))
        thumb.translatesAutoresizingMaskIntoConstraints = false
        thumb.contentMode = .scaleAspectFill; thumb.clipsToBounds = true
        thumb.layer.cornerRadius = 6; thumb.layer.borderColor = UIColor.white.cgColor; thumb.layer.borderWidth = 1.5
        view.addSubview(thumb)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            hint.topAnchor.constraint(equalTo: g.topAnchor, constant: 10),
            hint.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            hint.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, constant: -32),
            hint.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
            doneBtn.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -14),
            doneBtn.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            doneBtn.widthAnchor.constraint(equalToConstant: 116), doneBtn.heightAnchor.constraint(equalToConstant: 46),
            thumb.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -12),
            thumb.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            thumb.widthAnchor.constraint(equalToConstant: 46), thumb.heightAnchor.constraint(equalToConstant: 60),
            counter.centerYAnchor.constraint(equalTo: doneBtn.centerYAnchor),
            counter.centerXAnchor.constraint(equalTo: g.centerXAnchor),
        ])
    }

    private func setHint(_ s: String, warn: Bool = false) {
        let apply = {
            let t = "  \(s)  "
            if self.hint.text != t { self.hint.text = t }
            self.hint.backgroundColor = warn ? UIColor.systemOrange.withAlphaComponent(0.9) : UIColor.black.withAlphaComponent(0.55)
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
    }
    private func note(_ s: String) {
        nlog("tarayıcı: " + s)
        let t = String(format: "%.2f", CACurrentMediaTime() - t0)
        DispatchQueue.main.async { self.log.append("\(t) \(s)") }
    }

    // MARK: kamera
    private func configureSession() {
        guard let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: dev) else {
            setHint("Kamera yok", warn: true)
            return
        }
        session.beginConfiguration()
        session.sessionPreset = .photo
        if session.canAddInput(input) { session.addInput(input) }
        videoOut.alwaysDiscardsLateVideoFrames = true
        videoOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOut.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(videoOut) { session.addOutput(videoOut) }
        if session.canAddOutput(photoOut) { session.addOutput(photoOut) }
        if let d = dev.activeFormat.supportedMaxPhotoDimensions.last { photoOut.maxPhotoDimensions = d }
        photoOut.maxPhotoQualityPrioritization = .balanced
        for c in [videoOut.connection(with: .video), photoOut.connection(with: .video)] { rotatePortrait(c) }
        session.commitConfiguration()
        do {
            try dev.lockForConfiguration()
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.isAutoFocusRangeRestrictionSupported { dev.autoFocusRangeRestriction = .near }
            if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            dev.unlockForConfiguration()
        } catch {}
        let pv = AVCaptureVideoPreviewLayer(session: session)
        pv.videoGravity = .resizeAspect          // kadrajın tamamı görünür (dört köşe kuralı)
        rotatePortrait(pv.connection)
        view.layer.insertSublayer(pv, at: 0)
        view.layer.insertSublayer(quadLayer, above: pv)
        preview = pv
    }
    private func rotatePortrait(_ c: AVCaptureConnection?) {
        guard let c = c else { return }
        if #available(iOS 17.0, *) {
            if c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
        } else if c.isVideoOrientationSupported {
            c.videoOrientation = .portrait
        }
    }

    // MARK: her kare
    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb), !stopShooting else { return }
        let now = CACurrentMediaTime()
        bufSize = CGSize(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
        motion = frameMotion(pb)
        let req = VNDetectDocumentSegmentationRequest()
        let a = CACurrentMediaTime()
        try? VNImageRequestHandler(cvPixelBuffer: pb, orientation: .up, options: [:]).perform([req])
        let ms = (CACurrentMediaTime() - a) * 1000
        visionMs = visionMs == 0 ? ms : visionMs * 0.9 + ms * 0.1
        var q: PageQuad? = nil
        if let o = req.results?.first, o.confidence > 0.5 {
            let qq = PageQuad(o)
            if qq.area > 0.04 { q = qq }
        }
        step(q, pb: pb, now: now)
        DispatchQueue.main.async { self.drawQuad(q) }
    }

    /// otomatik çekim (videoQueue)
    private func step(_ q: PageQuad?, pb: CVPixelBuffer, now: CFTimeInterval) {
        guard let q = q else {
            history.removeAll(); visibleSince = 0
            if phase == .waitChange && now - lastSeen > 0.25 { disturbed = true }
            if phase == .hunting { setHint(S("show", "Sayfayı göster — kendiliğinden çekilir")) }
            return
        }
        lastSeen = now
        if visibleSince == 0 { visibleSince = now }
        history.append((now, q))
        history.removeAll { now - $0.t > 0.6 }
        let span = now - (history.first?.t ?? now)
        let wobble = history.map { $0.q.maxDist(q) }.max() ?? 1
        let stable = span >= 0.30 && wobble < 0.018
        let inFrame = q.inside(0.012)

        if forceShot && phase != .capturing {
            forceShot = false
            note("dokunarak çekim")
            shoot(q, pb: pb, now: now)
            return
        }
        switch phase {
        case .capturing:
            return
        case .waitChange:
            // sayfa çevrildi mi: görüntüde belirgin hareket (çevrilen yaprak, el), dörtgen kayboldu / oynadı
            if motion > 10 || wobble > 0.06 || (capQuad.map { $0.maxDist(q) > 0.12 } ?? false) { disturbed = true }
            guard stable && inFrame else { setHint(S("next", "✓ Tamam — sonraki sayfa")); return }
            if now - lastTextCheck < 0.35 { return }
            lastTextCheck = now
            // aynı sayfa mı: önce sayfadaki kelimeler (Apple metin tanıma, hızlı mod); yazısız sayfada görüntü imzası
            let img = CIImage(cvPixelBuffer: pb)
            let words = PageText.words(img, q)
            let sameText = PageText.same(words, lastWords)
            let sig = Self.signature(img, q)
            let d = (sig != nil && lastSig != nil) ? Self.sigDiff(sig!, lastSig!) : 9
            let isNew = sameText.map { !$0 } ?? (d > 0.55 || (disturbed && d > 0.30))
            if isNew {
                note(String(format: "yeni sayfa (kelime %d/%d ortak %d, imza farkı %.2f%@)", words.count, lastWords.count, words.intersection(lastWords).count, d, disturbed ? ", hareket" : ""))
                phase = .hunting; disturbed = false; newPageAt = now
            } else {
                if now - waitSince > 3, Int(now * 2) % 6 == 0 { note(String(format: "aynı sayfa bekleniyor (fark %.2f, hareket %@)", d, disturbed ? "var" : "yok")) }
                setHint(S("next", "✓ Tamam — sonraki sayfa")); return
            }
            fallthrough
        case .hunting:
            if !inFrame {
                // açık kitap kadrajı dolduruyor olabilir: köşe dışarıda ama sayfa 1 sn sabitse yine çekilir (kırpma yazıya göre yapılır)
                if stable { if outSince == 0 { outSince = now } } else { outSince = 0 }
                if outSince > 0 && now - outSince > 1.0 {
                    outSince = 0
                    note("köşe kadraj dışında ama 1 sn sabit → çekim")
                    shoot(q, pb: pb, now: now)
                    return
                }
                setHint(S("corners", "Dört köşe kadrajda olsun — telefonu biraz uzaklaştır"), warn: true); return
            }
            outSince = 0
            if !stable { setHint(S("hold", "Sabit tut — çekiliyor…")); return }
            note(String(format: "çekim (yeni sayfa→çekim %.2f sn, model %.0f ms)", newPageAt > 0 ? now - newPageAt : now - t0, visionMs))
            shoot(q, pb: pb, now: now)
        }
    }

    @objc private func tapShot() { videoQueue.async { self.forceShot = true } }

    private func shoot(_ q: PageQuad, pb: CVPixelBuffer, now: CFTimeInterval) {
        do {
            let img = CIImage(cvPixelBuffer: pb)
            lastSig = Self.signature(img, q)
            capQuad = q
            phase = .capturing
            setHint(S("hold", "Sabit tut — çekiliyor…"))
            let s = AVCapturePhotoSettings()
            s.photoQualityPrioritization = .balanced
            s.maxPhotoDimensions = photoOut.maxPhotoDimensions
            DispatchQueue.main.async {
                self.pending += 1
                self.photoOut.capturePhoto(with: s, delegate: self)
            }
            // deklanşörden sonra: bu sayfanın kelimeleri (sonraki sayfa / aynı sayfa ayrımı için)
            lastWords = PageText.words(img, q)
        }
    }

    // MARK: fotoğraf → dosya (+ köşeler)
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let liveQ = capQuad
        guard let data = photo.fileDataRepresentation() else {
            videoQueue.async { self.phase = .hunting }
            DispatchQueue.main.async { self.pending -= 1 }
            return
        }
        AudioServicesPlaySystemSound(1057)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        videoQueue.async { self.phase = .waitChange; self.disturbed = false; self.waitSince = CACurrentMediaTime() }
        procQueue.async {
            defer { DispatchQueue.main.async { self.pending -= 1 } }
            guard var img = CIImage(data: data, options: [.applyOrientationProperty: true]) else { return }
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
            // tam çözünürlüklü fotoğraftan kırpılır (sayfa kareyi doldurur → keskin), sonra düzleştirilir
            let tf = CACurrentMediaTime()
            let fr0 = PageFlattener.flatten(img, prefix: "canli", rejectBlurry: true)
            if let fr = fr0, fr.paths.isEmpty {
                // bulanık / sayfa çevrilirken çekilmiş: eklenmez, tarayıcı sayfayı sabitlenince yeniden çeker
                self.note("bulanık kare atıldı → yeniden çekilecek")
                self.videoQueue.async { if self.phase == .waitChange { self.phase = .hunting; self.newPageAt = CACurrentMediaTime() } }
                self.setHint(self.S("blurry", "Bulanık çıktı — sabit tut, yeniden çekiliyor"), warn: true)
                return
            }
            if let fr = fr0, let last = fr.paths.last, let ui = UIImage(contentsOfFile: URL(string: last)!.path) {
                let ms = (CACurrentMediaTime() - tf) * 1000
                let grp: [[String: Any]] = fr.paths.map { ["path": $0, "flat": true] }
                DispatchQueue.main.async {
                    // aynı sayfa ikinci kez çekildiyse (son 3 çekimle kelime karşılaştırması) daha dolu olan kalır
                    let lo = max(0, self.caps.count - 3)
                    for q in lo..<self.caps.count { let o = self.caps[q].words; nlog("tekrar denetimi: çekim \(q + 1) kelime \(o.count)/\(fr.words.count) ortak \(o.intersection(fr.words).count) → \(String(describing: PageText.same(fr.words, o)))") }
                    if let k = (lo..<self.caps.count).last(where: { PageText.same(fr.words, self.caps[$0].words) == true }) {
                        if fr.words.count > Int(Double(self.caps[k].words.count) * 1.1) || fr.paths.count > self.caps[k].pages.count {
                            self.caps[k] = (grp, fr.words)
                            self.note(String(format: "tekrar çekim: %d. çekimin yerine geçti (%d kelime, %d sayfa, %.0f ms)", k + 1, fr.words.count, grp.count, ms))
                        } else {
                            self.note(String(format: "tekrar çekim atıldı (%d. çekim daha dolu, %.0f ms)", k + 1, ms))
                        }
                    } else if fr.words.count < 2, let prev = self.caps.last, prev.words.count >= 30 {
                        // yazı sayfasından hemen sonra yazısız kare: büyük olasılıkla masa / el / sayfa çevrilirken → atılır
                        self.note("yazısız kare atıldı (masa / çevirme anı)")
                    } else {
                        self.caps.append((grp, fr.words))
                        self.note(String(format: "çekim %d: %d sayfa, %.0f ms (%d kelime)", self.caps.count, grp.count, ms, fr.words.count))
                    }
                    self.counter.text = self.S("count", "{n} sayfa").replacingOccurrences(of: "{n}", with: "\(self.pages.count)")
                    self.thumb.image = ui
                }
                return
            }
            // düzleştirici yoksa: web uygulamasının sakladığı karelerle aynı boyut (uzun kenar en çok 2600)
            let s = min(1, 2600 / max(img.extent.width, img.extent.height))
            let out = img.transformed(by: CGAffineTransform(scaleX: s, y: s))
            // köşeler fotoğrafta yeniden bulunur (daha kesin); bulunamazsa canlı dörtgen
            let ds = min(1, 1024 / max(out.extent.width, out.extent.height))
            var quad = liveQ
            let req = VNDetectDocumentSegmentationRequest()
            try? VNImageRequestHandler(ciImage: out.transformed(by: CGAffineTransform(scaleX: ds, y: ds)), options: [:]).perform([req])
            if let o = req.results?.first, o.confidence > 0.5 { let pq = PageQuad(o); if pq.area > 0.04 { quad = pq } }
            guard let cg = Self.ci.createCGImage(out, from: out.extent.integral),
                  let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else { return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("tarama-\(UUID().uuidString).jpg")
            do { try jpg.write(to: url) } catch { return }
            let thumbImg = UIImage(cgImage: cg)
            DispatchQueue.main.async {
                var page: [String: Any] = ["path": url.absoluteString]
                if let q = quad { page["quad"] = q.json }
                self.caps.append(([page], []))
                self.counter.text = self.S("count", "{n} sayfa").replacingOccurrences(of: "{n}", with: "\(self.pages.count)")
                self.thumb.image = thumbImg
            }
        }
    }

    /// kareler arası hareket: Y düzleminden 24×32 örnek, önceki kareyle ortalama mutlak fark
    private func frameMotion(_ pb: CVPixelBuffer) -> Double {
        let t = lumaThumb(pb)
        defer { prevThumb = t }
        guard let o = prevThumb else { return 0 }
        return thumbMotion(t, o)
    }

    // MARK: çizim
    private func drawQuad(_ q: PageQuad?) {
        guard let q = q, let pv = preview else { quadLayer.path = nil; dispQuad = nil; return }
        if let d = dispQuad, d.maxDist(q) < 0.15 {
            var m = d
            for i in 0..<4 { m.p[i] = CGPoint(x: d.p[i].x + (q.p[i].x - d.p[i].x) * 0.6, y: d.p[i].y + (q.p[i].y - d.p[i].y) * 0.6) }
            dispQuad = m
        } else { dispQuad = q }
        let r = AVMakeRect(aspectRatio: bufSize, insideRect: pv.bounds)
        let pts = dispQuad!.p.map { CGPoint(x: r.minX + $0.x * r.width, y: r.minY + $0.y * r.height) }
        let path = UIBezierPath()
        path.move(to: pts[0]); for p in pts.dropFirst() { path.addLine(to: p) }; path.close()
        let col: UIColor = q.inside(0.012) ? UIColor(red: 0.18, green: 0.88, blue: 0.69, alpha: 1) : .systemOrange
        CATransaction.begin(); CATransaction.setDisableActions(true)
        quadLayer.path = path.cgPath
        quadLayer.strokeColor = col.cgColor
        quadLayer.fillColor = col.withAlphaComponent(0.28).cgColor
        CATransaction.commit()
    }

    @objc private func finish() {
        guard !finishing else { return }
        finishing = true
        doneBtn.isEnabled = false
        doneBtn.alpha = 0.85
        videoQueue.async { self.stopShooting = true }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        // çekilmekte / düzleştirilmekte olan sayfalar beklenir; düğmede kalan sayı görünür (basıldığı anlaşılsın)
        func waitDone() {
            if pending > 0 {
                doneBtn.setTitle(S("finishing", "Hazırlanıyor… {n}").replacingOccurrences(of: "{n}", with: "\(pending)"), for: .disabled)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: waitDone); return
            }
            let total = CACurrentMediaTime() - t0
            log.append(String(format: "yerel tarama: %d sayfa, %.1f sn, belge modeli ort %.0f ms", pages.count, total, visionMs))
            videoQueue.async { self.session.stopRunning() }
            onFinish?(pages, log)
        }
        waitDone()
    }

    // MARK: sayfa içerik imzası (aynı sayfayı ikinci kez çekmemek için)
    static let SW = 24, SH = 32
    static func signature(_ img: CIImage, _ q: PageQuad) -> [Float]? {
        let e = img.extent
        func v(_ p: CGPoint) -> CIVector { CIVector(x: e.minX + p.x * e.width, y: e.minY + (1 - p.y) * e.height) }
        guard let f = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(v(q.p[0]), forKey: "inputTopLeft"); f.setValue(v(q.p[1]), forKey: "inputTopRight")
        f.setValue(v(q.p[2]), forKey: "inputBottomRight"); f.setValue(v(q.p[3]), forKey: "inputBottomLeft")
        guard let r = f.outputImage, r.extent.width > 1, r.extent.height > 1 else { return nil }
        let small = r.transformed(by: CGAffineTransform(translationX: -r.extent.minX, y: -r.extent.minY))
            .transformed(by: CGAffineTransform(scaleX: CGFloat(SW) / r.extent.width, y: CGFloat(SH) / r.extent.height))
        var buf = [UInt8](repeating: 0, count: SW * SH * 4)
        ci.render(small, toBitmap: &buf, rowBytes: SW * 4, bounds: CGRect(x: 0, y: 0, width: SW, height: SH), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        var g = [Float](repeating: 0, count: SW * SH)
        for i in 0..<(SW * SH) { g[i] = 0.299 * Float(buf[i*4]) + 0.587 * Float(buf[i*4+1]) + 0.114 * Float(buf[i*4+2]) }
        let m = g.reduce(0, +) / Float(g.count)
        var vv: Float = 0; for x in g { vv += (x - m) * (x - m) }
        let sd = max(4, (vv / Float(g.count)).squareRoot())
        return g.map { ($0 - m) / sd }
    }
    static func sigDiff(_ a: [Float], _ b: [Float]) -> Float {
        var best: Float = 99
        for dy in -1...1 { for dx in -1...1 {
            var s: Float = 0, n = 0
            for y in max(0, dy)..<(SH + min(0, dy)) { for x in max(0, dx)..<(SW + min(0, dx)) {
                s += abs(a[y * SW + x] - b[(y - dy) * SW + x - dx]); n += 1
            } }
            if n > 0 { best = min(best, s / Float(n)) }
        } }
        return best
    }
}

// MARK: - Video / fotoğraf içe aktarma (yerel)

/// Seçilen ya da kaydedilen videoyu Apple'ın belge modeliyle kare kare inceler: sayfanın durduğu her an (¼ sn+)
/// en net kare seçilir, aynı sayfa (içerik imzası) ikinci kez alınmaz. Fotoğraflarda yalnız köşeler bulunur.
/// Sonuç (tam çözünürlüklü JPEG + köşeler) web uygulamasına verilir; kırpma / düzleştirme / PDF orada yapılır.
final class MediaImporter: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private weak var host: UIViewController?
    private let strings: [String: String]
    private let done: ([[String: Any]], [String]) -> Void
    private var pages: [[String: Any]] = []
    private var log: [String] = []
    private var cancelled = false
    private var progressVC: ImportProgressViewController?
    private let work = DispatchQueue(label: "ns.import", qos: .userInitiated)
    private static let ci = CIContext(options: [.cacheIntermediates: false])

    init(host: UIViewController, strings: [String: String], done: @escaping ([[String: Any]], [String]) -> Void) {
        self.host = host; self.strings = strings; self.done = done
    }
    private func S(_ k: String, _ d: String) -> String { strings[k] ?? d }

    func pickFromLibrary() {
        var cfg = PHPickerConfiguration()
        cfg.selectionLimit = 0
        cfg.filter = .any(of: [.videos, .images])
        cfg.preferredAssetRepresentationMode = .current
        let pk = PHPickerViewController(configuration: cfg)
        pk.delegate = self
        host?.present(pk, animated: true)
    }
    func recordVideo() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { finish(); return }
        let pk = UIImagePickerController()
        pk.sourceType = .camera
        pk.mediaTypes = [UTType.movie.identifier]
        pk.videoQuality = .typeHigh
        pk.cameraCaptureMode = .video
        pk.videoMaximumDuration = 30 * 60
        pk.delegate = self
        host?.present(pk, animated: true)
    }

    // galeri
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        if results.isEmpty { finish(); return }
        showProgress()
        let group = DispatchGroup()
        var files = [(Int, URL, Bool)]()
        let lock = NSLock()
        for (i, r) in results.enumerated() {
            let p = r.itemProvider
            let isVideo = p.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
            let type = isVideo ? UTType.movie.identifier : UTType.image.identifier
            group.enter()
            p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                defer { group.leave() }
                guard let url = url else { return }
                // geçici dosya kapanış bloğundan sonra silinir: kopyala
                let dst = FileManager.default.temporaryDirectory.appendingPathComponent("ice-\(UUID().uuidString)-\(url.lastPathComponent)")
                if (try? FileManager.default.copyItem(at: url, to: dst)) != nil { lock.lock(); files.append((i, dst, isVideo)); lock.unlock() }
            }
        }
        group.notify(queue: work) {
            for (_, url, isVideo) in files.sorted(by: { $0.0 < $1.0 }) {
                if self.cancelled { break }
                if isVideo { self.analyzeVideo(url) } else { self.addImage(url) }
                try? FileManager.default.removeItem(at: url)
            }
            DispatchQueue.main.async { self.finish() }
        }
    }
    // kamera kaydı
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let url = info[.mediaURL] as? URL else { finish(); return }
        showProgress()
        work.async {
            self.analyzeVideo(url)
            DispatchQueue.main.async { self.finish() }
        }
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { picker.dismiss(animated: true); finish() }

    private func showProgress() {
        DispatchQueue.main.async {
            let vc = ImportProgressViewController(title: self.S("analyzing", "Video analiz ediliyor…"), cancel: self.S("cancel", "Vazgeç"))
            vc.onCancel = { [weak self] in self?.cancelled = true }
            vc.modalPresentationStyle = .overFullScreen
            self.progressVC = vc
            self.host?.present(vc, animated: true)
        }
    }
    private func progress(_ f: Double) {
        let txt = S("progress", "Kareler inceleniyor… {p}%").replacingOccurrences(of: "{p}", with: "\(Int(f * 100))")
        let sub = S("found", "{n} sayfa bulundu").replacingOccurrences(of: "{n}", with: "\(pages.count)")
        DispatchQueue.main.async { self.progressVC?.update(f, txt, sub) }
    }
    private func finish() {
        let out = pages.flatMap { pg -> [[String: Any]] in
            var a = pg; let more = a.removeValue(forKey: "more") as? [String] ?? []
            return [a] + more.map { ["path": $0, "flat": true] }
        }, lg = log
        if let vc = progressVC { vc.dismiss(animated: true) { self.done(out, lg) }; progressVC = nil }
        else { done(out, lg) }
    }

    // fotoğraf: köşeleri bul, 2600 px JPEG yaz
    private func addImage(_ url: URL) {
        guard var img = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { return }
        img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        if let pg = writePage(img) { pages.append(pg) }
    }
    /// görüntü → (uzun kenar ≤2600) JPEG + Apple belge modelinin köşeleri
    private func writePage(_ img: CIImage) -> [String: Any]? {
        // UVDoc: sayfayı kırpar ve düzleştirir (kıvrık kitap sayfası, perspektif); olmazsa ham kare + köşeler
        // açık kitap iki sayfa verir: ikincisi "more" ile taşınır, sonuç verilirken açılır (yerine koyma / sıra mantığı çekim başına)
        if let ps = PageFlattener.flattenToFile(img, prefix: "ice"), let first = ps.first {
            var pg: [String: Any] = ["path": first, "flat": true]
            if ps.count > 1 { pg["more"] = Array(ps.dropFirst()) }
            return pg
        }
        let s = min(1, 2600 / max(img.extent.width, img.extent.height))
        let out = img.transformed(by: CGAffineTransform(scaleX: s, y: s))
        let ds = min(1, 1024 / max(out.extent.width, out.extent.height))
        let req = VNDetectDocumentSegmentationRequest()
        try? VNImageRequestHandler(ciImage: out.transformed(by: CGAffineTransform(scaleX: ds, y: ds)), options: [:]).perform([req])
        guard let cg = Self.ci.createCGImage(out, from: out.extent.integral),
              let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tarama-\(UUID().uuidString).jpg")
        guard (try? jpg.write(to: url)) != nil else { return nil }
        var pg: [String: Any] = ["path": url.absoluteString]
        if let o = req.results?.first, o.confidence > 0.5 { let q = PageQuad(o); if q.area > 0.04 { pg["quad"] = q.json } }
        return pg
    }

    /// yazılmış sayfa JPEG'ini verilen yöne çevirip yeniden yaz
    private func rotatePage(_ pg: [String: Any], _ o: CGImagePropertyOrientation) -> [String: Any]? {
        guard let path = pg["path"] as? String, let url = URL(string: path), let im = CIImage(contentsOf: url) else { return nil }
        var r = im.oriented(o); r = r.transformed(by: CGAffineTransform(translationX: -r.extent.minX, y: -r.extent.minY))
        guard let cg = Self.ci.createCGImage(r, from: r.extent.integral), let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else { return nil }
        guard (try? jpg.write(to: url)) != nil else { return nil }
        return ["path": path]
    }

    // video: ~12 kare/sn incelenir
    private struct Frame { let pb: CVPixelBuffer; let t: Double; let quad: PageQuad?; let sharp: Double }
    private func analyzeVideo(_ url: URL) {
        let t0 = CACurrentMediaTime()
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .video).first, let reader = try? AVAssetReader(asset: asset) else { log.append("video açılamadı"); return }
        let dur = max(0.1, asset.duration.seconds)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { return }
        reader.add(out)
        reader.startReading()
        let orient = Self.orientation(track.preferredTransform)
        var lastT = -1.0, n = 0, runs = 0
        let before = pages.count
        var prevThumb: [UInt8]? = nil
        var prevQuad: PageQuad? = nil
        var motions: [Double] = []
        var runStart = -1.0, runEnd = -1.0, best: Frame? = nil   // durulan an: başlangıç, son, en net kare (yalnız o tutulur)
        var recent: [(idx: Int, sig: [Float]?, sets: [CGImagePropertyOrientation: (Set<String>, Double)], sharp: Double)] = []   // son 3 sayfa
        // yazının yönü video boyunca tek: tüm durgun anların güven puanları toplanır, en yüksek yön hepsine uygulanır
        var oScore: [CGImagePropertyOrientation: Double] = [:]
        func bestO() -> CGImagePropertyOrientation { oScore.max(by: { $0.value < $1.value })?.value ?? 0 > 2 ? oScore.max(by: { $0.value < $1.value })!.key : .up }
        var turned = true

        func endRun() {
            defer { runStart = -1; runEnd = -1; best = nil }
            guard runStart >= 0, runEnd - runStart >= 0.2, let best = best else { return }   // hazır videoda dört köşe şartı yok
            runs += 1
            let img = Self.oriented(best.pb, orient)
            let sets = PageText.wordSets(img, best.quad)
            for (o, v) in sets { oScore[o, default: 0] += v.1 }
            let o = sets.max(by: { $0.value.1 < $1.value.1 })?.key ?? .up    // bu karenin en güvenli okunan yönü
            let words = sets[o]?.0 ?? []
            let sig = best.quad.flatMap { LiveScannerViewController.signature(img, $0) }
            for (k, r) in recent.enumerated().reversed() {
                let rw = r.sets[o]?.0 ?? []
                var same: Bool
                if let st = PageText.same(words, rw) { same = st }
                else if let a = sig, let b = r.sig { same = LiveScannerViewController.sigDiff(a, b) < (turned ? 0.30 : 0.55) }
                else { same = !turned && k == recent.count - 1 }
                if same {
                    // aynı sayfa: daha tam (daha çok kelime) ya da belirgin daha netse öncekinin yerine
                    let fuller = words.count > Int(Double(rw.count) * 1.15) + 2
                    let sharper = words.count >= rw.count * 9 / 10 && best.sharp > r.sharp * 1.15
                    if fuller || sharper, let pg = writePage(img) { pages[r.idx] = pg; recent[k].sharp = best.sharp; recent[k].sets = sets; recent[k].sig = sig }
                    return
                }
            }
            if let pg = writePage(img) {
                pages.append(pg)
                recent.append((idx: pages.count - 1, sig: sig, sets: sets, sharp: best.sharp)); if recent.count > 3 { recent.removeFirst() }
                turned = false
            }
        }

        while reader.status == .reading, !cancelled, let sb = out.copyNextSampleBuffer() {
            let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            if t - lastT < 0.08 { continue }
            lastT = t
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            n += 1
            let sharp = Self.thumbAndSharpness(pb).1
            let thumb = lumaThumb(pb)
            var motion = 99.0
            if let o = prevThumb { motion = thumbMotion(thumb, o) }
            prevThumb = thumb
            // uyarlanır eşik: elde çekilen videonun titreme tabanına göre (son ~3 sn'nin alt %20'si)
            if motion < 99 { motions.append(motion); if motions.count > 36 { motions.removeFirst() } }
            let floor = motions.count >= 6 ? motions.sorted()[motions.count / 5] : 2
            let thr = max(3.5, min(10, floor * 1.8 + 1.5))
            if motion > max(14, thr * 2.5) { turned = true }
            let req = VNDetectDocumentSegmentationRequest()
            try? VNImageRequestHandler(cvPixelBuffer: pb, orientation: orient, options: [:]).perform([req])
            var q: PageQuad? = nil
            if let o = req.results?.first, o.confidence > 0.5 { let qq = PageQuad(o); if qq.area > 0.04 { q = qq } }
            // sayfa kadrajı dolduruyorsa köşe bulunamayabilir: o zaman yalnız hareketsizliğe bakılır
            let quadOk = q == nil || prevQuad == nil || prevQuad!.maxDist(q!) < 0.035
            let still = motion < thr && quadOk
            prevQuad = q
            if still {
                if runStart < 0 { runStart = t }
                runEnd = t
                if best == nil || sharp > best!.sharp { best = Frame(pb: pb, t: t, quad: q, sharp: sharp) }
            } else { endRun() }
            if n % 6 == 0 { progress(min(1, t / dur)) }
        }
        endRun()
        reader.cancelReading()
        let o = bestO()   // yalnız günlük için (sayfalar çevrilmez: yazılı sayfaların yönünü web uygulaması kendisi bulur)
        log.append(String(format: "video %.1f sn: %d kare incelendi, %d durgun an, %d sayfa, yön %d, %.1f sn", dur, n, runs, pages.count - before, Int(o.rawValue), CACurrentMediaTime() - t0))
    }

    private static func orientation(_ t: CGAffineTransform) -> CGImagePropertyOrientation {
        if t.a == 0 && t.b == 1 && t.c == -1 && t.d == 0 { return .right }
        if t.a == 0 && t.b == -1 && t.c == 1 && t.d == 0 { return .left }
        if t.a == -1 && t.b == 0 && t.c == 0 && t.d == -1 { return .down }
        return .up
    }
    private static func oriented(_ pb: CVPixelBuffer, _ o: CGImagePropertyOrientation) -> CIImage {
        let im = CIImage(cvPixelBuffer: pb).oriented(o)
        return im.transformed(by: CGAffineTransform(translationX: -im.extent.minX, y: -im.extent.minY))
    }
    /// Y düzleminden 24×32 küçük resim (hareket) + orta bölgede Laplace varyansı (netlik)
    private static func thumbAndSharpness(_ pb: CVPixelBuffer) -> ([UInt8], Double) {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return ([UInt8](repeating: 0, count: 768), 0) }
        let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0), bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var t = [UInt8](repeating: 0, count: 24 * 32)
        for y in 0..<32 { for x in 0..<24 { t[y * 24 + x] = p[(y * h / 32 + h / 64) * bpr + x * w / 24 + w / 48] } }
        var sum = 0.0, sum2 = 0.0, n = 0.0
        let x0 = w / 5, x1 = w * 4 / 5, y0 = h / 5, y1 = h * 4 / 5, step = max(2, min(w, h) / 160)
        var y = y0
        while y < y1 {
            var x = x0
            while x < x1 {
                let c = Int(p[y * bpr + x])
                let l = 4 * c - Int(p[y * bpr + x - 1]) - Int(p[y * bpr + x + 1]) - Int(p[(y - 1) * bpr + x]) - Int(p[(y + 1) * bpr + x])
                let v = Double(l); sum += v; sum2 += v * v; n += 1
                x += step
            }
            y += step
        }
        let m = n > 0 ? sum / n : 0
        return (t, n > 0 ? sum2 / n - m * m : 0)
    }
}

/// içe aktarma sırasında ilerleme ekranı
final class ImportProgressViewController: UIViewController {
    var onCancel: (() -> Void)?
    private let titleText: String, cancelText: String
    private let label = UILabel(), sub = UILabel(), bar = UIProgressView(progressViewStyle: .default)
    init(title: String, cancel: String) { titleText = title; cancelText = cancel; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.06, green: 0.08, blue: 0.13, alpha: 0.96)
        label.text = titleText; label.textColor = .white; label.font = .systemFont(ofSize: 18, weight: .semibold); label.textAlignment = .center; label.numberOfLines = 0
        sub.textColor = UIColor(white: 0.75, alpha: 1); sub.font = .systemFont(ofSize: 15); sub.textAlignment = .center
        bar.progressTintColor = UIColor(red: 0.18, green: 0.88, blue: 0.69, alpha: 1)
        let b = UIButton(type: .system); b.setTitle(cancelText, for: .normal); b.titleLabel?.font = .systemFont(ofSize: 17)
        b.addTarget(self, action: #selector(cancelTap), for: .touchUpInside)
        let st = UIStackView(arrangedSubviews: [label, bar, sub, b]); st.axis = .vertical; st.spacing = 16; st.alignment = .fill
        st.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(st)
        NSLayoutConstraint.activate([st.centerYAnchor.constraint(equalTo: view.centerYAnchor), st.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32), st.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)])
    }
    func update(_ f: Double, _ t: String, _ s: String) { bar.progress = Float(f); label.text = t; sub.text = s }
    @objc private func cancelTap() { onCancel?() }
}

// MARK: - Sayfa metni (Apple metin tanıma, cihazda)

enum PageText {
    private static let ci = CIContext(options: [.cacheIntermediates: false])

    /// dörtgen içini düzleştir (CI koordinatları sol-alt orijinli)
    static func rectify(_ img: CIImage, _ q: PageQuad) -> CIImage? {
        let e = img.extent
        func v(_ p: CGPoint) -> CIVector { CIVector(x: e.minX + p.x * e.width, y: e.minY + (1 - p.y) * e.height) }
        guard let f = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
        f.setValue(img, forKey: kCIInputImageKey)
        f.setValue(v(q.p[0]), forKey: "inputTopLeft"); f.setValue(v(q.p[1]), forKey: "inputTopRight")
        f.setValue(v(q.p[2]), forKey: "inputBottomRight"); f.setValue(v(q.p[3]), forKey: "inputBottomLeft")
        guard let r = f.outputImage, r.extent.width > 8, r.extent.height > 8 else { return nil }
        return r.transformed(by: CGAffineTransform(translationX: -r.extent.minX, y: -r.extent.minY))
    }

    /// hızlı kelime kümesi (aynı sayfa mı kontrolü için): 4+ harfli kelimeler, küçük harf.
    /// Yazı yan dönmüşse (yan tutulmuş açık kitap) diğer yönler de denenir.
    static func words(_ img: CIImage, _ q: PageQuad?) -> Set<String> { wordsAndOrientation(img, q).0 }
    /// kelimeler + yazının en çok okunduğu yön (yan dönmüş sayfayı düz çevirmek için)
    static func wordsAndOrientation(_ img: CIImage, _ q: PageQuad?) -> (Set<String>, CGImagePropertyOrientation) {
        var im = img
        if let q = q, let r = rectify(img, q) { im = r }
        let s = min(1, 1400 / max(im.extent.width, im.extent.height))
        im = im.transformed(by: CGAffineTransform(scaleX: s, y: s))
        var best = Set<String>(), bestO = CGImagePropertyOrientation.up
        for o in [CGImagePropertyOrientation.up, .right, .left, .down] {
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .fast
            req.usesLanguageCorrection = false
            req.recognitionLanguages = ["tr-TR", "en-US"]
            try? VNImageRequestHandler(ciImage: im, orientation: o, options: [:]).perform([req])
            var set = Set<String>()
            for r in req.results ?? [] {
                guard let t = r.topCandidates(1).first?.string.lowercased() else { continue }
                for w in t.split(whereSeparator: { !$0.isLetter }) where w.count >= 4 { set.insert(String(w)) }
            }
            if set.count > best.count { best = set; bestO = o }
            if best.count >= 25 { break }
        }
        return (best, bestO)
    }

    /// dört yönün her birinde kelime kümesi + güven puanı (Σ satır güveni × 4+ harfli kelime sayısı). Ters / yan duran yazı
    /// da "kelime" üretir ama güveni düşüktür; puan yönü seçer.
    static func wordSets(_ img: CIImage, _ q: PageQuad?) -> [CGImagePropertyOrientation: (Set<String>, Double)] {
        var im = img
        if let q = q, let r = rectify(img, q) { im = r }
        let s = min(1, 1400 / max(im.extent.width, im.extent.height))
        im = im.transformed(by: CGAffineTransform(scaleX: s, y: s))
        var out: [CGImagePropertyOrientation: (Set<String>, Double)] = [:]
        for o in [CGImagePropertyOrientation.up, .right, .left, .down] {
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .fast
            req.usesLanguageCorrection = false
            req.recognitionLanguages = ["tr-TR", "en-US"]
            try? VNImageRequestHandler(ciImage: im, orientation: o, options: [:]).perform([req])
            var set = Set<String>(), score = 0.0
            for r in req.results ?? [] {
                guard let c = r.topCandidates(1).first else { continue }
                let ws = c.string.lowercased().split(whereSeparator: { !$0.isLetter }).filter { $0.count >= 4 }
                for w in ws { set.insert(String(w)) }
                score += Double(c.confidence) * Double(ws.count)
            }
            out[o] = (set, score)
        }
        return out
    }

    /// iki kelime kümesi aynı sayfanın mı? true / false; kelimeler karar vermeye yetmiyorsa nil (görüntü imzasına bakılır)
    static func same(_ a: Set<String>, _ b: Set<String>) -> Bool? {
        let lo = min(a.count, b.count), hi = max(a.count, b.count)
        let r = lo > 0 ? Double(a.intersection(b).count) / Double(lo) : 0
        // dolu yazı sayfası: kısmi görüntü (kamera sayfanın üzerinde kaydı) aynı sayfanın alt kümesidir
        if lo >= 40 && r >= 0.4 { return true }
        // kelime sayıları çok farklı (dolu sayfa / az yazılı sayfa; iç kapak / imzalı sayfa): farklı sayfa
        if hi >= 15 && Double(lo) < Double(hi) * 0.3 { return false }
        if hi >= 8 && lo < 40 && Double(lo) < Double(hi) * 0.5 { return false }
        if lo >= 3 {
            // ortak kelimeler + benzer kelime sayısı (kitap adı gibi birkaç ortak kelime iki farklı az yazılı sayfada da olur)
            if r >= 0.45 && Double(lo) >= Double(hi) * 0.5 { return true }
            if r < 0.15 { return false }     // hızlı tanıma gürültülü olsa da aynı sayfada ortak kelime çıkar
        }
        return nil
    }

    /// aranabilir PDF / Word / TXT için tam metin tanıma: kelime kutuları (piksel, sol-üst orijin) + paragraflar
    static func recognize(_ url: URL, langs: [String]) -> [String: Any] {
        let t0 = CACurrentMediaTime()
        guard let img = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]),
              let cg = ci.createCGImage(img, from: img.extent.integral) else { return ["error": "image"] }
        let W = Double(cg.width), H = Double(cg.height)
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        if #available(iOS 16.0, *) { req.automaticallyDetectsLanguage = langs.isEmpty }
        let supported = (try? req.supportedRecognitionLanguages()) ?? []
        let want = langs.filter { l in supported.contains(l) || supported.contains { $0.hasPrefix(l.prefix(2)) } }
        if !want.isEmpty { req.recognitionLanguages = want }
        try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
        var words: [[Any]] = []
        var lines: [(y0: Double, y1: Double, x0: Double, text: String)] = []
        for r in req.results ?? [] {
            guard let c = r.topCandidates(1).first, c.confidence >= 0.3 else { continue }
            let s = c.string
            let lb = r.boundingBox
            lines.append((y0: (1 - lb.maxY) * H, y1: (1 - lb.minY) * H, x0: lb.minX * W, text: s))
            var idx = s.startIndex
            for part in s.split(separator: " ", omittingEmptySubsequences: true) {
                guard let rng = s.range(of: part, range: idx..<s.endIndex) else { continue }
                idx = rng.upperBound
                guard part.contains(where: { $0.isLetter || $0.isNumber }),
                      let box = try? c.boundingBox(for: rng)?.boundingBox else { continue }
                let x0 = box.minX * W, x1 = box.maxX * W, y0 = (1 - box.maxY) * H, y1 = (1 - box.minY) * H
                words.append([Int(x0.rounded()), Int(y0.rounded()), Int(x1.rounded()), Int(y1.rounded()), String(part), NSNull()])
            }
        }
        // satırlar → paragraflar: yukarıdan aşağı; satır aralığı belirgin açılınca ya da girinti başlayınca yeni paragraf
        lines.sort { $0.y0 < $1.y0 }
        let lh = lines.map { $0.y1 - $0.y0 }.sorted()
        let med = lh.isEmpty ? 20 : lh[lh.count / 2]
        let left = lines.map { $0.x0 }.sorted().first ?? 0
        var paras: [String] = [], cur = "", prevY1 = -1.0
        for l in lines {
            let gap = prevY1 < 0 ? 0 : l.y0 - prevY1
            let indent = l.x0 - left > med * 1.2
            if !cur.isEmpty && (gap > med * 0.9 || indent) { paras.append(cur); cur = "" }
            if cur.hasSuffix("-"), let f = l.text.first, f.isLowercase { cur.removeLast(); cur += l.text }
            else { cur += (cur.isEmpty ? "" : " ") + l.text }
            prevY1 = l.y1
        }
        if !cur.isEmpty { paras.append(cur) }
        return ["w": Int(W), "h": Int(H), "words": words, "paras": paras, "ms": Int((CACurrentMediaTime() - t0) * 1000)]
    }
}


// MARK: - Apple belge tarayıcısı (VisionKit)
final class AppleScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
    private let done: ([[String: Any]]) -> Void
    private let strings: [String: String]
    private let work = DispatchQueue(label: "ns.applescan", qos: .userInitiated)
    init(strings: [String: String] = [:], _ done: @escaping ([[String: Any]]) -> Void) { self.strings = strings; self.done = done }
    func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        // sayfalar hemen alınır, tarayıcı kapanır; düzleştirme (UVDoc) ARKA PLANDA, ilerleme ekranıyla yapılır
        // (ana iş parçacığında yapılınca ekran donuyordu)
        let imgs = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
        nlog("Apple tarayıcı: \(imgs.count) sayfa alındı")
        let host = c.presentingViewController
        c.dismiss(animated: true) {
            let pv = ImportProgressViewController(title: self.strings["preparing"] ?? "Sayfalar düzleştiriliyor…", cancel: self.strings["cancel"] ?? "Vazgeç")
            var cancelled = false
            pv.onCancel = { cancelled = true }
            pv.modalPresentationStyle = .overFullScreen
            host?.present(pv, animated: true)
            self.work.async {
                var pages: [[String: Any]] = []
                for (i, img) in imgs.enumerated() {
                    if cancelled { break }
                    DispatchQueue.main.async { pv.update(Double(i) / Double(max(1, imgs.count)), (self.strings["preparing"] ?? "Sayfalar düzleştiriliyor…") + " \(i + 1)/\(imgs.count)", "") }
                    autoreleasepool {
                        let t = CACurrentMediaTime()
                        if let cg = img.cgImage, let ps = PageFlattener.flattenToFile(CIImage(cgImage: cg), prefix: "apple", detect: false) { pages.append(contentsOf: ps.map { ["path": $0, "flat": true] }); nlog(String(format: "sayfa %d düzleştirildi %.0f ms (%dx%d)", i + 1, (CACurrentMediaTime() - t) * 1000, Int(img.size.width), Int(img.size.height))); return }
                        nlog("sayfa \(i + 1) düzleştirilemedi (cgImage \(img.cgImage != nil), model \(PageFlattener.ready))")
                        // düzleştirilemedi: Apple'ın kırptığı sayfa (uzun kenar ≤2600)
                        let s = min(1, 2600 / max(img.size.width, img.size.height))
                        let sz = CGSize(width: (img.size.width * s).rounded(), height: (img.size.height * s).rounded())
                        let r = UIGraphicsImageRenderer(size: sz, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
                        let out = r.image { _ in img.draw(in: CGRect(origin: .zero, size: sz)) }
                        guard let jpg = out.jpegData(compressionQuality: 0.92) else { return }
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent("apple-\(UUID().uuidString).jpg")
                        if (try? jpg.write(to: url)) != nil { pages.append(["path": url.absoluteString, "flat": true]) }
                    }
                }
                nlog("düzleştirme bitti: \(pages.count) sayfa")
                DispatchQueue.main.async { pv.dismiss(animated: true) { nlog("sonuç web'e veriliyor"); self.done(pages) } }
            }
        }
    }
    func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) { c.dismiss(animated: true) { self.done([]) } }
    func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) { c.dismiss(animated: true) { self.done([]) } }
}

// MARK: - Sayfa düzleştirme (UVDoc, Core ML)

/// UVDoc (MIT, Tanguy Magne 2023): kıvrık sayfa fotoğrafını düzleştirir. Model 488×712 girişten 2×45×31 ızgara verir
/// (her ızgara noktası: kaynak görüntüde [-1,1] konumu); ızgara tam çözünürlüğe çift doğrusal büyütülüp görüntü yeniden örneklenir.
final class Dewarper {
    let model: MLModel
    init(url: URL) throws {
        let cfg = MLModelConfiguration(); cfg.computeUnits = .all
        model = try MLModel(contentsOf: url, configuration: cfg)
    }
    private static let ci = CIContext(options: [.cacheIntermediates: false])

    /// ızgara (2×45×31): [x0..][y0..] (her biri 45×31)
    func grid(_ img: CGImage) throws -> [Float] {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, 488, 712, kCVPixelFormatType_32BGRA, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pb)
        guard let buf = pb else { throw NSError(domain: "uv", code: 1) }
        let ci = CIImage(cgImage: img)
        let sc = ci.transformed(by: CGAffineTransform(scaleX: 488 / ci.extent.width, y: 712 / ci.extent.height))
        Self.ci.render(sc, to: buf)
        let out = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["image": MLFeatureValue(pixelBuffer: buf)]))
        guard let a = out.featureValue(for: "grid")?.multiArrayValue else { throw NSError(domain: "uv", code: 2) }
        var g = [Float](repeating: 0, count: 2 * 45 * 31)
        for i in 0..<g.count { g[i] = a[i].floatValue }
        return g
    }

    /// görüntüyü ızgaraya göre yeniden örnekle (çıktı boyutu = giriş boyutu, uzun kenar en çok maxSide)
    func unwarp(_ img: CGImage, maxSide: Int = 2600) throws -> CGImage {
        let g = try grid(img)
        let W = img.width, H = img.height
        let s = min(1, Double(maxSide) / Double(max(W, H)))
        let OW = Int(Double(W) * s), OH = Int(Double(H) * s)
        // kaynak RGBA
        var src = [UInt8](repeating: 0, count: W * H * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: &src, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
        var dst = [UInt8](repeating: 255, count: OW * OH * 4)
        let GW = 31, GH = 45
        let gx = Array(g[0..<(GW * GH)]), gy = Array(g[(GW * GH)...])
        src.withUnsafeBufferPointer { sp in dst.withUnsafeMutableBufferPointer { dp in
            DispatchQueue.concurrentPerform(iterations: OH) { y in
                let v = Float(y) / Float(max(1, OH - 1)) * Float(GH - 1)
                let v0 = min(GH - 2, Int(v)), fv = v - Float(v0)
                for x in 0..<OW {
                    let u = Float(x) / Float(max(1, OW - 1)) * Float(GW - 1)
                    let u0 = min(GW - 2, Int(u)), fu = u - Float(u0)
                    let i00 = v0 * GW + u0, i01 = i00 + 1, i10 = i00 + GW, i11 = i10 + 1
                    let nx = (gx[i00] * (1 - fu) + gx[i01] * fu) * (1 - fv) + (gx[i10] * (1 - fu) + gx[i11] * fu) * fv
                    let ny = (gy[i00] * (1 - fu) + gy[i01] * fu) * (1 - fv) + (gy[i10] * (1 - fu) + gy[i11] * fu) * fv
                    // align_corners=True: -1 → 0, +1 → W-1
                    let sx = (nx + 1) / 2 * Float(W - 1), sy = (ny + 1) / 2 * Float(H - 1)
                    let o = (y * OW + x) * 4
                    if sx < 0 || sy < 0 || sx > Float(W - 1) || sy > Float(H - 1) { continue }
                    let x0 = min(W - 2, Int(sx)), y0 = min(H - 2, Int(sy)), fx = sx - Float(x0), fy = sy - Float(y0)
                    let p00 = (y0 * W + x0) * 4, p01 = p00 + 4, p10 = p00 + W * 4, p11 = p10 + 4
                    for c in 0..<3 {
                        let a = Float(sp[p00 + c]) * (1 - fx) + Float(sp[p01 + c]) * fx
                        let b = Float(sp[p10 + c]) * (1 - fx) + Float(sp[p11 + c]) * fx
                        dp[o + c] = UInt8(max(0, min(255, a * (1 - fy) + b * fy + 0.5)))
                    }
                    dp[o + 3] = 255
                }
            }
        } }
        let octx = CGContext(data: &dst, width: OW, height: OH, bitsPerComponent: 8, bytesPerRow: OW * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return octx.makeImage()!
    }
}

/// uygulama genelinde tek düzleştirici (model ilk kullanımda yüklenir; yüklenemezse nil → ham kare kullanılır)
// ==PIPE-BEGIN==
/// Çekilen kare → düz, dik, kırpılmış sayfa(lar). Telefonda ve Mac test aracında aynı kod.
/// 1) Apple doğru-mod metin tanıma (1000 px): yazı yönü, kelimeler, bulanıklık, satır kutuları
/// 2) Apple belge modeli: sayfa köşeleri. Açık kitapta çoğu zaman yalnız bir sayfayı bulur → kırpma alanı
///    yazının kapladığı alanla birleştirilir (iki sayfa da girer)
/// 3) Kare dik çevrilir; yazı sütunları arasında boşluk varsa açık kitap: sırttan ikiye ayrılır
/// 4) Her sayfa AYRI düzleştirilir (UVDoc tek sayfa için eğitildi; iki sayfayı birlikte düzleştirince satırlar eğri kalıyordu)
struct PipeResult {
    var images: [CGImage]
    var words: Set<String>
    var blurry: Bool
    var info: String
}

enum PagePipeline {
    static let ci = CIContext(options: [.cacheIntermediates: false])
    static var testHalfQuad = false
    static var debugSpine = false
    static var padSpine = true
    static var straighten = false     // satır düzleştirme web'deki satır izleme yolunda (daha sağlam); burada kapalı
    static var debugPre: [CGImage] = []

    struct Line { var x0, x1, y0, y1: CGFloat; var n: Int }

    /// sırt tarafına eklenen koyu şeridin düzleştirmeden sonra kalan kısmı: kenardan içeri, sütun ortancası kağıdın
    /// %60'ından koyu olan sütunlar kesilir (en çok %8). left: şerit sol kenarda (sağ sayfa)
    static func trimPad(_ cg: CGImage, left: Bool) -> CGImage {
        let w = 400, h = max(8, cg.height * 400 / max(1, cg.width))
        var g = [UInt8](repeating: 0, count: w * h)
        guard let ctx = CGContext(data: &g, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return cg }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        func med(_ x: Int) -> Double { var v: [UInt8] = []; for y in stride(from: h / 10, to: h * 9 / 10, by: 3) { v.append(g[y * w + x]) }; v.sort(); return Double(v[v.count / 2]) }
        var c: [Double] = []; for x in stride(from: w / 3, to: w * 2 / 3, by: 5) { c.append(med(x)) }; c.sort()
        let paper = c[c.count / 2]
        var n = 0
        while n < w * 8 / 100 && med(left ? n : w - 1 - n) < paper * 0.6 { n += 1 }
        guard n > 0 else { return cg }
        let cut = Int(Double(n + 1) * Double(cg.width) / Double(w))
        let r = left ? CGRect(x: cut, y: 0, width: cg.width - cut, height: cg.height) : CGRect(x: 0, y: 0, width: cg.width - cut, height: cg.height)
        return cg.cropping(to: r) ?? cg
    }

    static func run(_ img0: CIImage, dewarper d: Dewarper, detect: Bool = true, maxSide: Int = 2200, stopIfBlurry: Bool = false) -> PipeResult? {
        let img = img0.transformed(by: CGAffineTransform(translationX: -img0.extent.minX, y: -img0.extent.minY))
        let W = img.extent.width, H = img.extent.height
        let k = min(1, 1000 / max(W, H))
        let small = img.transformed(by: CGAffineTransform(scaleX: k, y: k))
        var info: [String] = []

        // 1) metin
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.recognitionLanguages = ["tr-TR", "en-US"]
        try? VNImageRequestHandler(ciImage: small, orientation: .up, options: [:]).perform([req])
        let obs = req.results ?? []
        var dx = 0.0, dy = 0.0, chars = 0, low = 0
        var words = Set<String>()
        for r in obs {
            let w = Double(r.topRight.x - r.topLeft.x) * Double(W), h = Double(r.topRight.y - r.topLeft.y) * Double(H)
            let L = (w * w + h * h).squareRoot(); if L < 1e-6 { continue }
            let cand = r.topCandidates(1).first, str = cand?.string ?? ""
            chars += str.count; if (cand?.confidence ?? 0) < 0.5 { low += str.count }
            dx += w / L * Double(str.count); dy += h / L * Double(str.count)
            for x in str.lowercased().split(whereSeparator: { !$0.isLetter }) where x.count >= 4 { words.insert(String(x)) }
        }
        let blurry = chars >= 300 && Double(low) >= Double(chars) * 0.5
        var o = CGImagePropertyOrientation.up
        // az yazılı sayfada da (imza / iç kapak): baskın eksen diğerinin 2 katıysa yön kesin sayılır
        let big = max(abs(dx), abs(dy)), small2 = min(abs(dx), abs(dy))
        if big >= 40 || (big >= 12 && big >= small2 * 2) { o = abs(dx) >= abs(dy) ? (dx > 0 ? .up : .down) : (dy > 0 ? .right : .left) }
        info.append("yön \(o.rawValue) harf \(chars)" + (blurry ? " BULANIK" : ""))
        // bulanık kare düzleştirilmez (zaman kaybı): çağıran yeniden çeker
        if blurry && stopIfBlurry { return PipeResult(images: [], words: words, blurry: true, info: info.joined(separator: "; ")) }

        // dik kare ve kaynak → dik normalize eşlemesi (CIImage'ın kendi yön dönüşümüyle)
        let t = img.orientationTransform(for: o)
        var U = img.transformed(by: t)
        let uo = U.extent.origin
        U = U.transformed(by: CGAffineTransform(translationX: -uo.x, y: -uo.y))
        let UW = U.extent.width, UH = U.extent.height
        func up(_ p: CGPoint) -> CGPoint { let q = CGPoint(x: p.x * W, y: p.y * H).applying(t); return CGPoint(x: (q.x - uo.x) / UW, y: (q.y - uo.y) / UH) }

        // satır kutuları (dik, normalize, sol-alt orijin)
        var lines: [Line] = []
        for r in obs {
            // kısa satırlar da (içindekilerdeki "21" gibi sayfa numaraları) sütun boşluğu hesabına girer
            guard let c = r.topCandidates(1).first, c.string.trimmingCharacters(in: .whitespaces).count >= 1, c.confidence >= 0.3 else { continue }
            let ps = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map(up)
            lines.append(Line(x0: ps.map { $0.x }.min()!, x1: ps.map { $0.x }.max()!, y0: ps.map { $0.y }.min()!, y1: ps.map { $0.y }.max()!, n: c.string.count))
        }

        // 2) sayfa köşeleri (dik koordinatta)
        var quad: [CGPoint]? = nil
        if detect {
            let seg = VNDetectDocumentSegmentationRequest()
            try? VNImageRequestHandler(ciImage: small, options: [:]).perform([seg])
            if let q = seg.results?.first, q.confidence > 0.5 {
                // dik karede köşelerin rolü değişir (kaynağın sol-üstü artık başka köşe): konuma göre yeniden adlandırılır
                let m = [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft].map(up)
                let pts = [m.max { ($0.y - $0.x) < ($1.y - $1.x) }!, m.max { ($0.x + $0.y) < ($1.x + $1.y) }!,
                           m.max { ($0.x - $0.y) < ($1.x - $1.y) }!, m.min { ($0.x + $0.y) < ($1.x + $1.y) }!]
                var a: CGFloat = 0
                for i in 0..<4 { let p = pts[i], n = pts[(i + 1) % 4]; a += p.x * n.y - n.x * p.y }
                if abs(a) / 2 > 0.08 { quad = pts }
                // test: köşe modelinin açık kitapta yalnız sol sayfayı bulmasını taklit et
                if testHalfQuad, let q0 = quad { let mx = (q0[0].x + q0[1].x) / 2, mb = (q0[3].x + q0[2].x) / 2; quad = [q0[0], CGPoint(x: mx, y: q0[1].y), CGPoint(x: mb, y: q0[2].y), q0[3]] }
            }
        }
        // yazı alanı (gürültü satırları dışarıda: en az 2 satırın desteklediği sınırlar)
        var tb: CGRect? = nil
        if lines.count >= 2 {
            let xs0 = lines.map { $0.x0 }.sorted(), xs1 = lines.map { $0.x1 }.sorted(), ys0 = lines.map { $0.y0 }.sorted(), ys1 = lines.map { $0.y1 }.sorted()
            tb = CGRect(x: xs0[1], y: ys0[1], width: xs1[xs1.count - 2] - xs0[1], height: ys1[ys1.count - 2] - ys0[1])
            if lines.count < 6 { tb = CGRect(x: xs0[0], y: ys0[0], width: xs1.last! - xs0[0], height: ys1.last! - ys0[0]) }
        }
        let clamp = { (r: CGRect) -> CGRect in r.intersection(CGRect(x: 0, y: 0, width: 1, height: 1)) }

        // kırpma: köşeler yazının tamamını kapsıyorsa perspektif kırpma (köşeler %6 dışa); kapsamıyorsa
        // (açık kitapta yalnız bir sayfa bulundu) köşe kutusu ∪ yazı alanı, eksene paralel
        var region: CGRect
        var persp: [CGPoint]? = nil
        if let q = quad {
            let qb = CGRect(x: q.map { $0.x }.min()!, y: q.map { $0.y }.min()!, width: q.map { $0.x }.max()! - q.map { $0.x }.min()!, height: q.map { $0.y }.max()! - q.map { $0.y }.min()!)
            // köşelerin dışında kalan yazı: yan sayfanın TAMAMI görünüyorsa (açık kitap, yazı bloğu içerdekinin en az %60'ı
            // genişliğinde ve yarısı yüksekliğinde) birleştirilir; kenarda kalan şerit (yan sayfanın kenarı) dikkate alınmaz
            let qe = qb.insetBy(dx: -0.01, dy: -0.01)
            let inL = lines.filter { qe.contains(CGPoint(x: ($0.x0 + $0.x1) / 2, y: ($0.y0 + $0.y1) / 2)) }
            let outL = lines.filter { !qe.contains(CGPoint(x: ($0.x0 + $0.x1) / 2, y: ($0.y0 + $0.y1) / 2)) }
            func box(_ ls: [Line]) -> CGRect? { ls.isEmpty ? nil : CGRect(x: ls.map { $0.x0 }.min()!, y: ls.map { $0.y0 }.min()!, width: ls.map { $0.x1 }.max()! - ls.map { $0.x0 }.min()!, height: ls.map { $0.y1 }.max()! - ls.map { $0.y0 }.min()!) }
            let ib = box(inL), ob = box(outL)
            let otherPage = outL.count >= 4 && ob != nil && (ib == nil || (ob!.width * UW >= ib!.width * UW * 0.6 && ob!.height >= ib!.height * 0.5))
            if let t0 = tb, otherPage, !qb.insetBy(dx: -0.02, dy: -0.02).contains(t0) {
                region = clamp(qb.union(t0.insetBy(dx: -0.04, dy: -0.04)).insetBy(dx: -0.015, dy: -0.015))
                info.append("köşeler tek sayfayı buldu, yan sayfa da görünüyor → ikisi birlikte")
            } else {
                let cx = q.map { $0.x }.reduce(0, +) / 4, cy = q.map { $0.y }.reduce(0, +) / 4
                persp = q.map { CGPoint(x: min(1, max(0, cx + ($0.x - cx) * 1.06)), y: min(1, max(0, cy + ($0.y - cy) * 1.06))) }
                region = clamp(qb.insetBy(dx: -qb.width * 0.03, dy: -qb.height * 0.03))
            }
        } else if let t0 = tb {
            region = clamp(t0.insetBy(dx: -0.06, dy: -0.06)); info.append("köşe yok → yazı alanı")
        } else {
            region = CGRect(x: 0, y: 0, width: 1, height: 1)
        }

        // 3) açık kitap mı: kırpma alanı yatay ve yazı sütunları arasında satırların kesmediği bir boşluk var
        var cuts: [CGRect] = [region]
        let rwPx = region.width * UW, rhPx = region.height * UH
        let inR = lines.filter { region.insetBy(dx: -0.01, dy: -0.01).contains(CGPoint(x: ($0.x0 + $0.x1) / 2, y: ($0.y0 + $0.y1) / 2)) }
        if rwPx > rhPx * 1.05 && inR.count >= 6 {
            // satırların kesmediği boşluklar (bölgenin %25-%75'i). İçindekiler sayfasında yazı ile sayfa numaraları arasındaki
            // boşluk da böyle görünür: sırt, boşluklar içinde kağıdın en koyu olduğu sütundur (sırt gölgesi)
            var gaps: [(a: CGFloat, b: CGFloat)] = []
            var x = region.minX + region.width * 0.25, start: CGFloat? = nil
            let step: CGFloat = 0.002
            while x <= region.minX + region.width * 0.75 {
                let cross = inR.contains { $0.x0 < x && $0.x1 > x }
                if !cross { if start == nil { start = x } } else if let s0 = start { gaps.append((s0, x)); start = nil }
                x += step
            }
            if let s0 = start { gaps.append((s0, x)) }
            gaps = gaps.filter { ($0.b - $0.a) >= region.width * 0.012 }
            // kağıt parlaklığı sütun profili (dik küçük görüntüde, bölge yüksekliğinin orta %80'i)
            let Us = U.transformed(by: CGAffineTransform(scaleX: 600 / max(UW, UH), y: 600 / max(UW, UH)))
            var prof: [CGFloat: Double] = [:]
            if let cg = ci.createCGImage(Us, from: Us.extent.integral) {
                let w = cg.width, h = cg.height
                var buf = [UInt8](repeating: 0, count: w * h)
                let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
                let y0 = Int((1 - region.maxY + region.height * 0.1) * CGFloat(h)), y1 = Int((1 - region.minY - region.height * 0.1) * CGFloat(h))
                for g in gaps {
                    var xx = g.a
                    while xx <= g.b {
                        let px = min(w - 1, max(0, Int(xx * CGFloat(w))))
                        var v: [UInt8] = []
                        for yy in stride(from: max(0, y0), to: min(h, y1), by: 2) { v.append(buf[yy * w + px]) }
                        v.sort(); prof[xx] = v.isEmpty ? 255 : Double(v[v.count * 8 / 10])
                        xx += step
                    }
                }
            }
            if debugSpine { for g in gaps { print(String(format: "boşluk %.3f-%.3f", g.a, g.b)) }; for k in prof.keys.sorted() { print(String(format: "  %.3f %.0f", k, prof[k]!)) } }
            // her boşluğun en koyu sütunu; en koyusu (eşitse ortaya en yakın) sırt
            var best: (x: CGFloat, v: Double)? = nil
            for g in gaps {
                var gx = (g.a + g.b) / 2, gv = 999.0
                for (k, v) in prof where k >= g.a && k <= g.b { if v < gv { gv = v; gx = k } }
                let pen = Double(abs(gx - region.midX) / region.width) * 20     // merkezden uzaklık hafif cezalı
                if best == nil || gv + pen < best!.v { best = (gx, gv + pen) }
            }
            if let b = best {
                let l = inR.filter { $0.x1 <= b.x }.count, r = inR.filter { $0.x0 >= b.x }.count
                if l + r >= 6 && min(l, r) >= 1 {
                    cuts = [CGRect(x: region.minX, y: region.minY, width: b.x - region.minX, height: region.height),
                            CGRect(x: b.x, y: region.minY, width: region.maxX - b.x, height: region.height)]
                    persp = nil
                    info.append(String(format: "açık kitap: sırt %.3f (%d boşluk, sol %d sağ %d satır)", b.x, gaps.count, l, r))
                }
            }
        }

        // 4) her sayfa ayrı düzleştirilir
        var outs: [CGImage] = []
        for c in cuts {
            var page: CIImage
            if let p = persp, let f = CIFilter(name: "CIPerspectiveCorrection") {
                func v(_ q: CGPoint) -> CIVector { CIVector(x: q.x * UW, y: q.y * UH) }
                f.setValue(U, forKey: kCIInputImageKey)
                f.setValue(v(p[0]), forKey: "inputTopLeft"); f.setValue(v(p[1]), forKey: "inputTopRight")
                f.setValue(v(p[2]), forKey: "inputBottomRight"); f.setValue(v(p[3]), forKey: "inputBottomLeft")
                page = f.outputImage ?? U
            } else {
                page = U.cropped(to: CGRect(x: c.minX * UW, y: c.minY * UH, width: c.width * UW, height: c.height * UH).integral)
            }
            page = page.transformed(by: CGAffineTransform(translationX: -page.extent.minX, y: -page.extent.minY))
            guard page.extent.width > 100, page.extent.height > 100 else { continue }
            // açık kitabın yarısı: kesilen (sırt) tarafa koyu bir şerit eklenir. Böylece UVDoc sayfa kenarını kesim çizgisi
            // sayar; yoksa sırt gölgesini kenar sanıp sırta yakın içeriği (içindekilerdeki sayfa numaraları) kesiyordu
            if cuts.count == 2 && padSpine {
                let isLeft = c.minX <= region.minX + 1e-6
                let pw = page.extent.width * 0.06
                let bg = CIImage(color: CIColor(red: 0.16, green: 0.16, blue: 0.16)).cropped(to: CGRect(x: 0, y: 0, width: page.extent.width + pw, height: page.extent.height))
                let moved = isLeft ? page : page.transformed(by: CGAffineTransform(translationX: pw, y: 0))
                page = moved.composited(over: bg)
            }
            let s = min(1, CGFloat(maxSide) / max(page.extent.width, page.extent.height))
            if s < 1 { page = page.transformed(by: CGAffineTransform(scaleX: s, y: s)) }
            guard let cg = ci.createCGImage(page, from: page.extent.integral) else { continue }
            if debugSpine { debugPre.append(cg) }
            var flat = (try? d.unwarp(cg, maxSide: maxSide)) ?? cg
            if cuts.count == 2 && padSpine { flat = trimPad(flat, left: c.minX > region.minX + 1e-6) }
            outs.append(Straighten.cleanEdges(straighten ? Straighten.apply(flat, &info) : flat, &info))
        }
        guard !outs.isEmpty else { return nil }
        return PipeResult(images: outs, words: words, blurry: blurry, info: info.joined(separator: "; "))
    }
}

/// UVDoc'tan sonra kalan küçük eğiklik ve dalgalanma: yazı satırlarından ölçülür ve giderilir.
/// Kelime merkezlerinden her satırın eğrisi çıkarılır → satırlar yatay yapılır (dikey kaydırma alanı);
/// paragrafların sol / sağ kenarı (yaslı yazı) dik çizgiye oturtulur (satır başına yatay ölçek + kaydırma).
/// Ölçüm yetersizse (az satır) görüntüye dokunulmaz.
enum Straighten {
    struct Row { var xs: [CGFloat]; var ys: [CGFloat]; var t: CGFloat; var h: CGFloat; var x0: CGFloat; var x1: CGFloat; var text: String = "" }
    struct Seg { var text: String; var x0, x1, y0, y1: CGFloat }
    static var lastSegs: [Seg] = []

    /// satırlar: kelime merkezleri (normalize, sol-üst orijin)
    static var ocrSide: CGFloat = 1600
    static func rows(_ cg: CGImage) -> [Row] {
        var im = CIImage(cgImage: cg)
        let k = min(1, ocrSide / max(im.extent.width, im.extent.height))
        im = im.transformed(by: CGAffineTransform(scaleX: k, y: k))
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.recognitionLanguages = ["tr-TR", "en-US"]
        try? VNImageRequestHandler(ciImage: im, orientation: .up, options: [:]).perform([req])
        var segs: [Row] = []
        lastSegs = []
        for r in req.results ?? [] {
            guard let c = r.topCandidates(1).first else { continue }
            let bb = r.boundingBox
            lastSegs.append(Seg(text: c.string, x0: bb.minX, x1: bb.maxX, y0: 1 - bb.maxY, y1: 1 - bb.minY))
            guard c.confidence >= 0.4 else { continue }
            let str = c.string
            var xs: [CGFloat] = [], ys: [CGFloat] = [], hs: [CGFloat] = []
            var x0: CGFloat = 1, x1: CGFloat = 0
            str.enumerateSubstrings(in: str.startIndex..<str.endIndex, options: .byWords) { _, rg, _, _ in
                guard let b = try? c.boundingBox(for: rg) else { return }
                let pts = [b.topLeft, b.topRight, b.bottomRight, b.bottomLeft]
                let cx = pts.map { $0.x }.reduce(0, +) / 4, cy = 1 - pts.map { $0.y }.reduce(0, +) / 4
                xs.append(cx); ys.append(cy); hs.append(abs(b.topLeft.y - b.bottomLeft.y))
                x0 = min(x0, pts.map { $0.x }.min()!); x1 = max(x1, pts.map { $0.x }.max()!)
            }
            if xs.isEmpty { continue }
            let h = hs.sorted()[hs.count / 2]
            segs.append(Row(xs: xs, ys: ys, t: ys.sorted()[ys.count / 2], h: h, x0: x0, x1: x1))
        }
        // aynı yükseklikteki parçalar (yazı + sağdaki sayfa numarası) tek satırda birleşir
        segs.sort { $0.t < $1.t }
        var rows: [Row] = []
        for sg in segs {
            if var last = rows.last, abs(sg.t - last.t) < min(sg.h, last.h) * 0.6 {
                last.xs += sg.xs; last.ys += sg.ys; last.x0 = min(last.x0, sg.x0); last.x1 = max(last.x1, sg.x1)
                last.h = max(last.h, sg.h); rows[rows.count - 1] = last
            } else { rows.append(sg) }
        }
        for i in rows.indices {
            let o = zip(rows[i].xs, rows[i].ys).sorted { $0.0 < $1.0 }
            rows[i].xs = o.map { $0.0 }; rows[i].ys = o.map { $0.1 }
            rows[i].t = rows[i].ys.sorted()[rows[i].ys.count / 2]
        }
        return rows
    }

    /// satırın x'teki sapması (eğri - hedef), uçlarda sabit
    static func dev(_ r: Row, _ x: CGFloat) -> CGFloat {
        let n = r.xs.count
        if n == 1 { return r.ys[0] - r.t }
        if x <= r.xs[0] { return r.ys[0] - r.t }
        if x >= r.xs[n - 1] { return r.ys[n - 1] - r.t }
        var i = 0; while i < n - 2 && r.xs[i + 1] < x { i += 1 }
        let f = (x - r.xs[i]) / max(1e-6, r.xs[i + 1] - r.xs[i])
        return r.ys[i] + (r.ys[i + 1] - r.ys[i]) * f - r.t
    }

    /// en küçük kareler 2. derece: y = a + b t + c t²
    static func fit2(_ ts: [CGFloat], _ vs: [CGFloat]) -> (CGFloat) -> CGFloat {
        var S = [[Double]](repeating: [Double](repeating: 0, count: 4), count: 3)
        for (t, v) in zip(ts, vs) { let tt = Double(t), vv = Double(v); let p = [1, tt, tt * tt]; for i in 0..<3 { for j in 0..<3 { S[i][j] += p[i] * p[j] }; S[i][3] += p[i] * vv } }
        for c in 0..<3 { var pr = c; for r in c..<3 where abs(S[r][c]) > abs(S[pr][c]) { pr = r }; S.swapAt(c, pr); let d = S[c][c]; if abs(d) < 1e-12 { let m = vs.reduce(0, +) / CGFloat(max(1, vs.count)); return { _ in m } }
            for j in c..<4 { S[c][j] /= d }; for r in 0..<3 where r != c { let f = S[r][c]; for j in c..<4 { S[r][j] -= f * S[c][j] } } }
        let a = S[0][3], b = S[1][3], c2 = S[2][3]
        return { t in CGFloat(a + b * Double(t) + c2 * Double(t) * Double(t)) }
    }

    /// kenar (sol ya da sağ): yaslı satırların ucu; aykırılar atılarak 2. derece eğri
    static func margin(_ rows: [Row], left: Bool) -> ((CGFloat) -> CGFloat, Int)? {
        let ends = rows.filter { $0.xs.count >= 3 }.map { left ? $0.x0 : $0.x1 }
        guard ends.count >= 6 else { return nil }
        let q = ends.sorted()[left ? ends.count * 15 / 100 : ends.count * 85 / 100]
        var cand = rows.filter { $0.xs.count >= 3 && abs((left ? $0.x0 : $0.x1) - q) < 0.02 }
        for _ in 0..<2 {
            guard cand.count >= 6 else { return nil }
            let f = fit2(cand.map { $0.t }, cand.map { left ? $0.x0 : $0.x1 })
            cand = cand.filter { abs(f($0.t) - (left ? $0.x0 : $0.x1)) < 0.006 }
        }
        guard cand.count >= 6, let tMin = cand.map({ $0.t }).min(), let tMax = cand.map({ $0.t }).max(), tMax - tMin > 0.35 else { return nil }
        return (fit2(cand.map { $0.t }, cand.map { left ? $0.x0 : $0.x1 }), cand.count)
    }

    /// iki tur: ikinci tur birincinin bıraktığı küçük eğikliği ölçüp giderir
    static func apply(_ cg: CGImage, _ log: inout [String]) -> CGImage {
        let a = applyOnce(cg, &log, clean: false)
        if a === cg { return cleanBleedIf(cg, &log) }
        return applyOnce(a, &log, clean: true)
    }
    static func cleanBleedIf(_ cg: CGImage, _ log: inout [String]) -> CGImage { cg }
    static func applyOnce(_ cg: CGImage, _ log: inout [String], clean: Bool) -> CGImage {
        let rows = rows(cg)
        let curved = rows.filter { $0.xs.count >= 3 && $0.x1 - $0.x0 > 0.25 }
        guard curved.count >= 4 else { log.append("düzlük: az satır, dokunulmadı"); return cg }
        // ölçüm: satır içi sapma (önce)
        let before = curved.map { r in r.xs.indices.map { abs(r.ys[$0] - r.t) }.max() ?? 0 }.sorted()[curved.count / 2]
        let L = margin(rows, left: true), R = margin(rows, left: false)
        let W = cg.width, H = cg.height
        // satır başına kenar dönüşümü (yalnız iki kenar da ölçülebildiyse)
        // satır başına: xs = a[y] + b[y] * x (hesap piksel döngüsünün dışında)
        var ra = [Float](repeating: 0, count: H), rb = [Float](repeating: 1, count: H)
        if let l = L?.0, let r = R?.0 {
            let ts = rows.map { $0.t }
            let lm = ts.map(l).reduce(0, +) / CGFloat(ts.count), rm = ts.map(r).reduce(0, +) / CGFloat(ts.count)
            if rm - lm > 0.3 {
                // kenar eğrisi yazının dışında uzatılmaz (sabit)
                let tmin = ts.min()!, tmax = ts.max()!
                for py in 0..<H {
                    let y = min(tmax, max(tmin, (CGFloat(py) + 0.5) / CGFloat(H)))
                    let sc = (r(y) - l(y)) / (rm - lm)
                    rb[py] = Float(sc); ra[py] = Float(l(y) - lm * sc)
                }
            }
        }
        // dikey kaydırma alanı: ızgara (GX × GY), satır hedefleri arasında doğrusal
        let GX = 40, GY = 60
        var D = [CGFloat](repeating: 0, count: (GX + 1) * (GY + 1))
        let rs = rows.filter { $0.xs.count >= 2 || $0.x1 - $0.x0 > 0.05 }
        guard rs.count >= 4 else { return cg }
        for gy in 0...GY {
            let y = CGFloat(gy) / CGFloat(GY)
            var a = 0; while a < rs.count - 1 && rs[a + 1].t <= y { a += 1 }
            for gx in 0...GX {
                let x = CGFloat(gx) / CGFloat(GX)
                var d: CGFloat
                if y <= rs[0].t { d = dev(rs[0], x) }
                else if a >= rs.count - 1 { d = dev(rs[rs.count - 1], x) }
                else { let f = (y - rs[a].t) / max(1e-6, rs[a + 1].t - rs[a].t); d = dev(rs[a], x) * (1 - f) + dev(rs[a + 1], x) * f }
                D[gy * (GX + 1) + gx] = d
            }
        }
        // güvenlik: kaydırma büyükse (yanlış satır birleşmesi) dokunulmaz
        let maxD = D.map { abs($0) }.max() ?? 0
        guard maxD < 0.03 else { log.append(String(format: "düzlük: kaydırma çok büyük (%.3f), dokunulmadı", maxD)); return cg }
        let Df = D.map { Float($0) }
        var src = [UInt8](repeating: 0, count: W * H * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: &src, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
        var dst = [UInt8](repeating: 255, count: W * H * 4)
        let fW = Float(W), fH = Float(H), fGX = Float(GX), fGY = Float(GY)
        src.withUnsafeBufferPointer { sp in dst.withUnsafeMutableBufferPointer { dp in Df.withUnsafeBufferPointer { dd in
            DispatchQueue.concurrentPerform(iterations: H) { py in
                let y = (Float(py) + 0.5) / fH
                let a = ra[py], b = rb[py]
                let v = min(fGY, max(0, y * fGY)), v0 = min(GY - 1, Int(v)), fv = v - Float(v0)
                for px in 0..<W {
                    let xs = a + b * ((Float(px) + 0.5) / fW)
                    let u = min(fGX, max(0, xs * fGX))
                    let u0 = min(GX - 1, Int(u)), fu = u - Float(u0)
                    let i00 = v0 * (GX + 1) + u0
                    let top: Float = dd[i00] * (1 - fu) + dd[i00 + 1] * fu
                    let bot: Float = dd[i00 + GX + 1] * (1 - fu) + dd[i00 + GX + 2] * fu
                    let d: Float = top * (1 - fv) + bot * fv
                    // görüntü dışı → kenar pikseli (beyaz doldurma sonraki temizlemede gölge gibi görünüyordu)
                    let sx = min(Float(W - 1), max(0, xs * fW - 0.5)), sy = min(Float(H - 1), max(0, (y + d) * fH - 0.5))
                    let o = (py * W + px) * 4
                    let x0 = min(W - 2, Int(sx)), y0 = min(H - 2, Int(sy)), fx = sx - Float(x0), fy = sy - Float(y0)
                    let p00 = (y0 * W + x0) * 4, p01 = p00 + 4, p10 = p00 + W * 4, p11 = p10 + 4
                    for c in 0..<3 {
                        let a = Float(sp[p00 + c]) * (1 - fx) + Float(sp[p01 + c]) * fx
                        let b = Float(sp[p10 + c]) * (1 - fx) + Float(sp[p11 + c]) * fx
                        dp[o + c] = UInt8(max(0, min(255, a * (1 - fy) + b * fy + 0.5)))
                    }
                    dp[o + 3] = 255
                }
            }
        } } }
        let octx = CGContext(data: &dst, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        guard let out = octx.makeImage() else { return cg }
        log.append(String(format: "düzlük: %d satır, sapma %.4f, kenar %@/%@", curved.count, before, L != nil ? "sol" : "-", R != nil ? "sağ" : "-"))
        return clean ? cleanBleed(out, rows: rows, &log) : out
    }


    /// alttaki / yandaki sayfanın kenardan görünen kesik satır başları: ana yazı bloğunun dışında, metin tanımanın
    /// OKUYAMADIĞI (sayfa numarası, kelime okunur ve korunur), dar (≤ %3.5) ve sayfa boyunca dizilmiş küçük izler →
    /// kenardan o sütunun hemen ötesine kadar kağıt rengine boyanır
    static func cleanBleed(_ cg: CGImage, rows: [Row], _ log: inout [String]) -> CGImage {
        let full = rows.filter { $0.xs.count >= 3 }
        guard full.count >= 4 else { return cg }
        let lx = full.map { $0.x0 }.sorted()[full.count / 10], rx = full.map { $0.x1 }.sorted()[full.count * 9 / 10]
        let segs = lastSegs
        // küçük gri kopya
        let w = 600, h = max(8, Int(CGFloat(cg.height) * 600 / CGFloat(cg.width)))
        var g = [UInt8](repeating: 0, count: w * h)
        guard let gctx = CGContext(data: &g, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return cg }
        gctx.interpolationQuality = .medium
        gctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        // yalnız sayfanın orta %84'ü (üst / alt kenardaki sayfa numarası, başlık korunur) ve en dıştaki %9
        let y0 = h * 8 / 100, y1 = h * 92 / 100
        func inkCols(_ xa: Int, _ xb: Int) -> [Int] {
            var out: [Int] = []
            guard xb > xa else { return out }
            for x in xa..<xb {
                var v: [UInt8] = []; for y in stride(from: y0, to: y1, by: 2) { v.append(g[y * w + x]) }
                let paper = Double(v.sorted()[v.count * 8 / 10])
                var n = 0; for y in stride(from: y0, to: y1, by: 2) where Double(g[y * w + x]) < paper * 0.75 { n += 1 }
                if n >= 2 { out.append(x) }
            }
            return out
        }
        func zone(_ xa: Int, _ xb: Int) -> CGRect? {
            let cols = inkCols(xa, xb)
            guard let a = cols.first, let b = cols.last else { return nil }
            guard CGFloat(b - a) <= CGFloat(w) * 0.04 else { return nil }
            // en az 5 ayrı iz (alt alta harfler) ya da sayfa boyu uzun bir çizgi: tek bir okunamayan işaret silinmez
            var runs = 0, longest = 0, cur = 0, inRun = false
            for y in y0..<y1 {
                var dark = false
                for x in a...b { if Double(g[y * w + x]) < 0.75 * Double(g[y * w + min(w - 1, b + 6)]) { dark = true; break } }
                if dark { cur += 1; if !inRun { runs += 1; inRun = true } } else { longest = max(longest, cur); cur = 0; inRun = false }
            }
            longest = max(longest, cur)
            guard runs >= 5 || longest > (y1 - y0) / 7 else { return nil }
            let na = CGFloat(a) / CGFloat(w) - 0.004, nb = CGFloat(b) / CGFloat(w) + 0.004
            // metin tanıma bu sütunda bir şey okuduysa (numara, kelime) içeriktir
            // (tek-iki harflik parçalar sayılmaz: kesik satır başlarından metin tanıma bazen "i" gibi tek harf okur)
            func content(_ q: Seg) -> Bool { let t = q.text.trimmingCharacters(in: .whitespaces); return t.count >= 3 || t.contains(where: { $0.isNumber }) }
            if segs.contains(where: { content($0) && $0.x1 > na && $0.x0 < nb && $0.y1 > 0.08 && $0.y0 < 0.92 }) { return nil }
            return CGRect(x: na, y: 0, width: nb - na, height: 1)
        }
        var fills: [CGRect] = []
        let outer: CGFloat = 0.2     // alttaki sayfanın izi kenardan %13'e kadar içeride görülebiliyor
        if let z = zone(0, Int(min(lx - 0.012, outer) * CGFloat(w))) { fills.append(CGRect(x: 0, y: 0.08, width: min(z.maxX + 0.003, lx - 0.008), height: 0.84)) }
        if let z = zone(Int(max(rx + 0.012, 1 - outer) * CGFloat(w)), w) { let x = max(z.minX - 0.003, rx + 0.008); fills.append(CGRect(x: x, y: 0.08, width: 1 - x, height: 0.84)) }
        guard !fills.isEmpty else { return cg }
        let W = CGFloat(cg.width), H = CGFloat(cg.height)
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = ctx.data else { return cg }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
        let px = data.bindMemory(to: UInt8.self, capacity: cg.width * cg.height * 4)
        for f in fills {
            // kağıt rengi: boyanan şeridin hemen içindeki kenar boşluğu (üst çeyrek)
            let sx = Int((f.minX < 0.01 ? f.maxX + 0.006 : f.minX - 0.006) * W)
            var rs: [Int] = [], gs: [Int] = [], bs: [Int] = []
            for y in stride(from: Int(H * 0.1), to: Int(H * 0.9), by: 7) { let o = (y * cg.width + max(0, min(cg.width - 1, sx))) * 4; rs.append(Int(px[o])); gs.append(Int(px[o + 1])); bs.append(Int(px[o + 2])) }
            rs.sort(); gs.sort(); bs.sort()
            ctx.setFillColor(CGColor(colorSpace: cs, components: [CGFloat(rs[rs.count * 3 / 4]) / 255, CGFloat(gs[gs.count * 3 / 4]) / 255, CGFloat(bs[bs.count * 3 / 4]) / 255, 1])!)
            ctx.fill(CGRect(x: f.minX * W, y: (1 - f.maxY) * H, width: f.width * W, height: f.height * H))
        }
        log.append(String(format: "yan sayfa izi temizlendi (%@)", fills.map { String(format: "%.3f-%.3f", $0.minX, $0.maxX) }.joined(separator: ", ")))
        return ctx.makeImage() ?? cg
    }


    /// kenar temizliği (düzleştirmeden sonra): yazı alanının dışındaki koyu kenar şeritleri (yan sayfanın kenarı, sırt
    /// gölgesi, masa) ve okunamayan ince izler kağıt rengine boyanır. Yazı alanı = satırlar + okunan her parça
    /// (sayfa numarası, başlık); onun içine hiç dokunulmaz
    static func cleanEdges(_ cg: CGImage, _ log: inout [String]) -> CGImage {
        let rws = rows(cg)
        let segs = lastSegs
        func content(_ q: Seg) -> Bool { let t = q.text.trimmingCharacters(in: .whitespaces); return t.count >= 3 || t.contains(where: { $0.isNumber }) }
        let cs = segs.filter(content)
        guard cs.count >= 2 else { return cg }
        var cx0 = cs.map { $0.x0 }.min()!, cx1 = cs.map { $0.x1 }.max()!, cy0 = cs.map { $0.y0 }.min()!, cy1 = cs.map { $0.y1 }.max()!
        cx0 = max(0, cx0 - 0.012); cx1 = min(1, cx1 + 0.012); cy0 = max(0, cy0 - 0.012); cy1 = min(1, cy1 + 0.012)
        var out = cleanBleed(cg, rows: rws, &log)
        // küçük gri kopya: sütun / satır kağıt düzeyi (üst %20)
        let w = 500, h = max(8, out.height * 500 / max(1, out.width))
        var g = [UInt8](repeating: 0, count: w * h)
        guard let gctx = CGContext(data: &g, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return out }
        gctx.draw(out, in: CGRect(x: 0, y: 0, width: w, height: h))
        func px(_ x: Int, _ y: Int) -> UInt8 { g[y * w + x] }     // bit eşlem belleği üstten başlar
        var ref: [UInt8] = []
        for y in stride(from: Int(cy0 * CGFloat(h)), to: Int(cy1 * CGFloat(h)), by: 4) { for x in stride(from: Int(cx0 * CGFloat(w)), to: Int(cx1 * CGFloat(w)), by: 4) { ref.append(px(x, y)) } }
        guard ref.count > 50 else { return out }
        ref.sort(); let paper = Double(ref[ref.count * 8 / 10])
        // kapak / fotoğraflı sayfa: yazı alanında kağıttan belirgin koyu piksel çoksa dokunulmaz (kapak zemini kağıt değil)
        // (web'deki ölçüyle aynı: tüm sayfanın orta %84'ünde, en parlak %10'a göre koyu piksel oranı; yazı ≤ %14, kapak ≈ %38)
        var allv: [UInt8] = []
        for y in stride(from: h * 8 / 100, to: h * 92 / 100, by: 3) { for x in stride(from: w * 8 / 100, to: w * 92 / 100, by: 3) { allv.append(px(x, y)) } }
        allv.sort()
        let p90 = Double(allv[allv.count * 9 / 10])
        let darkFrac = Double(allv.filter { Double($0) < p90 * 0.6 }.count) / Double(max(1, allv.count))
        if PagePipeline.debugSpine { print(String(format: "  koyu oranı %.3f", darkFrac)) }
        if darkFrac > 0.25 { log.append(String(format: "kenar temizliği yok (grafik sayfa, koyu %%%.0f)", darkFrac * 100)); return out }
        // renkli zemin (mavi gökyüzü gibi): kenar bandı renkliyse de dokunulmaz — aşağıda yalnız gri / kahverengi bant boyanır
        func colPaper(_ x: Int) -> Double { var v: [UInt8] = []; for y in stride(from: 0, to: h, by: 3) { v.append(px(x, y)) }; v.sort(); return Double(v[v.count * 8 / 10]) }
        func rowPaper(_ y: Int) -> Double { var v: [UInt8] = []; for x in stride(from: 0, to: w, by: 3) { v.append(px(x, y)) }; v.sort(); return Double(v[v.count * 8 / 10]) }
        // kenardan içeri: kağıttan %12+ koyu sütun / satırlar (yazı alanına girmeden)
        var L = 0; while L < Int(cx0 * CGFloat(w)) && colPaper(L) < paper * 0.88 { L += 1 }
        var R = 0; while R < Int((1 - cx1) * CGFloat(w)) && colPaper(w - 1 - R) < paper * 0.88 { R += 1 }
        var T = 0; while T < Int(cy0 * CGFloat(h)) && rowPaper(T) < paper * 0.88 { T += 1 }
        var B = 0; while B < Int((1 - cy1) * CGFloat(h)) && rowPaper(h - 1 - B) < paper * 0.88 { B += 1 }
        guard L + R + T + B > 0 else { return out }
        let W = CGFloat(out.width), H = CGFloat(out.height)
        let space = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: nil, width: out.width, height: out.height, bitsPerComponent: 8, bytesPerRow: out.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = ctx.data else { return out }
        ctx.draw(out, in: CGRect(x: 0, y: 0, width: W, height: H))
        // kağıt rengi: yazı alanındaki parlak piksellerin ortancası
        let p8 = data.bindMemory(to: UInt8.self, capacity: out.width * out.height * 4)
        var rs: [Int] = [], gs: [Int] = [], bs: [Int] = []
        for y in stride(from: Int(cy0 * H), to: Int(cy1 * H), by: 9) { for x in stride(from: Int(cx0 * W), to: Int(cx1 * W), by: 9) {
            let o = (y * out.width + x) * 4; let l = 0.299 * Double(p8[o]) + 0.587 * Double(p8[o + 1]) + 0.114 * Double(p8[o + 2])
            if l >= paper * 0.97 * 1.0 { rs.append(Int(p8[o])); gs.append(Int(p8[o + 1])); bs.append(Int(p8[o + 2])) } } }
        guard rs.count > 20 else { return out }
        rs.sort(); gs.sort(); bs.sort()
        ctx.setFillColor(CGColor(colorSpace: space, components: [CGFloat(rs[rs.count / 2]) / 255, CGFloat(gs[gs.count / 2]) / 255, CGFloat(bs[bs.count / 2]) / 255, 1])!)
        let sx = W / CGFloat(w), sy = H / CGFloat(h)
        if L > 0 { ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(L + 1) * sx, height: H)) }
        if R > 0 { ctx.fill(CGRect(x: W - CGFloat(R + 1) * sx, y: 0, width: CGFloat(R + 1) * sx, height: H)) }
        if T > 0 { ctx.fill(CGRect(x: 0, y: H - CGFloat(T + 1) * sy, width: W, height: CGFloat(T + 1) * sy)) }
        if B > 0 { ctx.fill(CGRect(x: 0, y: 0, width: W, height: CGFloat(B + 1) * sy)) }
        log.append(String(format: "kenar gölgesi temizlendi (sol %d sağ %d üst %d alt %d / %d px)", L, R, T, B, w))
        out = ctx.makeImage() ?? out
        return out
    }
    /// ölçüm (test): satır içi en büyük sapmaların ortancası ve kenar sapması
    static func measure(_ cg: CGImage) -> (CGFloat, CGFloat) {
        let rs = rows(cg).filter { $0.xs.count >= 3 && $0.x1 - $0.x0 > 0.25 }
        guard !rs.isEmpty else { return (0, 0) }
        let dv = rs.map { r in r.xs.indices.map { abs(r.ys[$0] - r.t) }.max() ?? 0 }.sorted()[rs.count / 2]
        var mg: CGFloat = 0
        if let l = margin(rs, left: true)?.0 { let ts = rs.map { $0.t }; let v = ts.map(l); mg = (v.max()! - v.min()!) }
        return (dv, mg)
    }
}
// ==PIPE-END==

enum PageFlattener {
    private static let lock = NSLock()
    private static var dw: Dewarper? = nil
    private static var tried = false
    private static let ci = CIContext(options: [.cacheIntermediates: false])
    static var ready: Bool { get_() != nil }
    private static func get_() -> Dewarper? {
        lock.lock(); defer { lock.unlock() }
        if !tried {
            tried = true
            if let url = Bundle.main.url(forResource: "UVDoc", withExtension: "mlmodelc") {
                let t = CACurrentMediaTime()
                do { dw = try Dewarper(url: url); nlog(String(format: "UVDoc modeli yüklendi %.0f ms", (CACurrentMediaTime() - t) * 1000)) }
                catch { nlog("UVDoc modeli yüklenemedi: \(error)") }
            } else { nlog("UVDoc.mlmodelc bulunamadı") }
        }
        return dw
    }
    /// sayfayı dik çevirmek için gereken yön. Apple'ın doğru (accurate) metin tanıması yazıyı her yönde okur ve satır
    /// köşelerini verir: okuma yönü vektörü (sol-üst → sağ-üst, kelime uzunluğuyla ağırlıklı) yazının nereye baktığını söyler.
    /// (Hızlı mod ve güven puanı ters / yan yazıyı ayırt edemiyor — Mac'te dört yönle doğrulandı.) Yazısız sayfada .up
    static func uprightOrientation(_ cg: CGImage) -> CGImagePropertyOrientation { orientationAndWords(cg).0 }
    /// yön + sayfadaki 4+ harfli kelimeler (doğru mod her yönde okur; aynı sayfa ikinci kez çekildi mi kontrolü için)
    static func orientationAndWords(_ cg: CGImage) -> (CGImagePropertyOrientation, Set<String>) { let r = analyze(cg); return (r.0, r.1) }
    /// yön + kelimeler + bulanık mı. Bulanık / sayfa çevrilirken çekilmiş karede yazının çoğu düşük güvenle okunur
    /// (telefondaki örneklerde harflerin %71-87'si; iyi sayfalarda %0-3). Az yazılı sayfa (imza, kapak) bu ölçüye girmez.
    static func analyze(_ cg: CGImage) -> (CGImagePropertyOrientation, Set<String>, Bool) {
        var im = CIImage(cgImage: cg)
        let k = min(1, 1000 / max(im.extent.width, im.extent.height))
        im = im.transformed(by: CGAffineTransform(scaleX: k, y: k))
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.recognitionLanguages = ["tr-TR", "en-US"]
        try? VNImageRequestHandler(ciImage: im, orientation: .up, options: [:]).perform([req])
        var dx = 0.0, dy = 0.0
        var words = Set<String>()
        var chars = 0, low = 0
        for r in req.results ?? [] {
            let w = Double(r.topRight.x - r.topLeft.x), h = Double(r.topRight.y - r.topLeft.y)
            let L = (w * w + h * h).squareRoot(); if L < 1e-6 { continue }
            let cand = r.topCandidates(1).first
            let str = cand?.string ?? ""
            chars += str.count; if (cand?.confidence ?? 0) < 0.5 { low += str.count }
            let c = Double(str.count)
            dx += w / L * c; dy += h / L * c
            for x in str.lowercased().split(whereSeparator: { !$0.isLetter }) where x.count >= 4 { words.insert(String(x)) }
        }
        let blurry = chars >= 300 && Double(low) >= Double(chars) * 0.5
        if max(abs(dx), abs(dy)) < 40 { return (.up, words, blurry) }            // yazı çok az: dokunulmaz
        if abs(dx) >= abs(dy) { return (dx > 0 ? .up : .down, words, blurry) }
        return (dy > 0 ? .right : .left, words, blurry)                          // (CIImage.oriented ile doğrulanmış eşleme)
    }

    /// Apple belge modeliyle sayfa köşeleri (normalize, CI koordinatı: sol-alt orijin) — TL, TR, BR, BL
    static func detectQuad(_ img: CIImage) -> [CGPoint]? {
        let ds = min(1, 1024 / max(img.extent.width, img.extent.height))
        let req = VNDetectDocumentSegmentationRequest()
        try? VNImageRequestHandler(ciImage: img.transformed(by: CGAffineTransform(scaleX: ds, y: ds)), options: [:]).perform([req])
        guard let o = req.results?.first, o.confidence > 0.5 else { return nil }
        let q = [o.topLeft, o.topRight, o.bottomRight, o.bottomLeft]
        var a: CGFloat = 0
        for k in 0..<4 { let p = q[k], n = q[(k + 1) % 4]; a += p.x * n.y - n.x * p.y }
        return abs(a) / 2 > 0.08 ? q : nil
    }

    /// görüntü → düz sayfa JPEG(ler)i (açık kitapta iki sayfa) → yollar; başarısızsa nil
    static func flattenToFile(_ img: CIImage, prefix: String = "duz", detect: Bool = true) -> [String]? { flatten(img, prefix: prefix, detect: detect)?.paths }

    /// PagePipeline: yazı yönü + köşeler ∪ yazı alanı ile kırpma + açık kitabı sırttan ayırma + her sayfayı ayrı UVDoc.
    /// rejectBlurry: bulanık karede düzleştirme yapılmaz, paths boş döner (çağıran yeniden çeker)
    static func flatten(_ img: CIImage, prefix: String = "duz", detect: Bool = true, rejectBlurry: Bool = false) -> (paths: [String], words: Set<String>, blurry: Bool)? {
        guard let d = get_() else { return nil }
        guard let r = PagePipeline.run(img, dewarper: d, detect: detect, maxSide: 2200, stopIfBlurry: rejectBlurry) else { return nil }
        nlog("boru hattı: " + r.info)
        if r.images.isEmpty { return ([], r.words, r.blurry) }
        var paths: [String] = []
        for cg in r.images {
            guard let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else { continue }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString).jpg")
            if (try? jpg.write(to: url)) != nil { paths.append(url.absoluteString) }
        }
        return paths.isEmpty ? nil : (paths, r.words, r.blurry)
    }
}

/// Quick Look veri kaynağı (tek PDF)
final class PdfPreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    let url: URL
    let onClose: () -> Void
    init(url: URL, onClose: @escaping () -> Void) { self.url = url; self.onClose = onClose }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    func previewControllerDidDismiss(_ controller: QLPreviewController) { onClose() }
}
