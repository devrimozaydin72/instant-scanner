import UIKit
import CoreML
import AVFoundation
import Vision
import CoreImage
import AudioToolbox
import Capacitor
import PhotosUI
import VisionKit
import UniformTypeIdentifiers

/// Capacitor köprüsü: yerel eklentiyi (NativeScanner) kaydeder
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeScannerPlugin())
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
        CAPPluginMethod(name: "appleScan", returnType: CAPPluginReturnPromise)
    ]
    private var appleScanner: AppleScanDelegate?

    /// Apple'ın belge tarayıcısı (VisionKit — Notlar / Dosyalar'daki tarayıcı): otomatik çekim, köşe, perspektif ve ışık
    /// düzeltmesi Apple'da; sayfalar düzleştirilmiş JPEG olarak döner → {pages:[{path, flat:true}], log}
    @objc func appleScan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard VNDocumentCameraViewController.isSupported, let host = self.bridge?.viewController else { call.reject("unsupported"); return }
            let t0 = CACurrentMediaTime()
            let d = AppleScanDelegate(strings: call.getObject("strings") as? [String: String] ?? [:]) { pages in
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
            let imp = MediaImporter(host: host, strings: strings) { pages, log in call.resolve(["pages": pages, "log": log]); self.importer = nil }
            self.importer = imp
            imp.pickFromLibrary()
        }
    }
    /// telefonun kamerasıyla video kaydet → yerelde incele → {pages}
    @objc func record(_ call: CAPPluginCall) {
        let strings = call.getObject("strings") as? [String: String] ?? [:]
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("no view controller"); return }
            let imp = MediaImporter(host: host, strings: strings) { pages, log in call.resolve(["pages": pages, "log": log]); self.importer = nil }
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
    private var pages: [[String: Any]] = []
    private var log: [String] = []
    private var pending = 0
    private var finishing = false
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
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
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
            // web uygulamasının sakladığı karelerle aynı boyut (uzun kenar en çok 2600)
            let s = min(1, 2600 / max(img.extent.width, img.extent.height))
            let out = img.transformed(by: CGAffineTransform(scaleX: s, y: s))
            // köşeler fotoğrafta yeniden bulunur (daha kesin); bulunamazsa canlı dörtgen
            let ds = min(1, 1024 / max(out.extent.width, out.extent.height))
            var quad = liveQ
            let req = VNDetectDocumentSegmentationRequest()
            try? VNImageRequestHandler(ciImage: out.transformed(by: CGAffineTransform(scaleX: ds, y: ds)), options: [:]).perform([req])
            if let o = req.results?.first, o.confidence > 0.5 { let pq = PageQuad(o); if pq.area > 0.04 { quad = pq } }
            if let path = PageFlattener.flattenToFile(out, prefix: "canli"), let ui = UIImage(contentsOfFile: URL(string: path)!.path) {
                DispatchQueue.main.async {
                    self.pages.append(["path": path, "flat": true])
                    self.counter.text = self.S("count", "{n} sayfa").replacingOccurrences(of: "{n}", with: "\(self.pages.count)")
                    self.thumb.image = ui
                }
                return
            }
            guard let cg = Self.ci.createCGImage(out, from: out.extent.integral),
                  let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) else { return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("tarama-\(UUID().uuidString).jpg")
            do { try jpg.write(to: url) } catch { return }
            let thumbImg = UIImage(cgImage: cg)
            DispatchQueue.main.async {
                var page: [String: Any] = ["path": url.absoluteString]
                if let q = quad { page["quad"] = q.json }
                self.pages.append(page)
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
        // çekilmekte / yazılmakta olan sayfa beklenir
        func waitDone() {
            if pending > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: waitDone); return }
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
        let out = pages, lg = log
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
        if let path = PageFlattener.flattenToFile(img, prefix: "ice") { return ["path": path, "flat": true] }
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
        if lo >= 40 && r >= 0.45 { return true }
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
                        if let cg = img.cgImage, let path = PageFlattener.flattenToFile(CIImage(cgImage: cg), prefix: "apple") { pages.append(["path": path, "flat": true]); return }
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
                DispatchQueue.main.async { pv.dismiss(animated: true) { self.done(pages) } }
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
            if let url = Bundle.main.url(forResource: "UVDoc", withExtension: "mlmodelc") { dw = try? Dewarper(url: url) }
        }
        return dw
    }
    /// görüntüyü düzleştirip (uzun kenar ≤2600) JPEG olarak geçici klasöre yazar → yol; başarısızsa nil
    static func flattenToFile(_ img: CIImage, prefix: String = "duz") -> String? {
        guard let d = get_() else { return nil }
        var img = img
        // düzleştirme 2000 px'te (okunaklılık için yeterli; yeniden örnekleme ~%40 daha hızlı)
        let k = min(1, 2000 / max(img.extent.width, img.extent.height))
        if k < 1 { img = img.transformed(by: CGAffineTransform(scaleX: k, y: k)) }
        let e = img.extent
        guard let cg = ci.createCGImage(img, from: e.integral) else { return nil }
        guard let out = try? d.unwarp(cg, maxSide: 2000) else { return nil }
        guard let jpg = UIImage(cgImage: out).jpegData(compressionQuality: 0.92) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(prefix)-\(UUID().uuidString).jpg")
        return (try? jpg.write(to: url)) != nil ? url.absoluteString : nil
    }
}
