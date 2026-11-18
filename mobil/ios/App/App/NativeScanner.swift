import UIKit
import AVFoundation
import Vision
import CoreImage
import AudioToolbox
import Capacitor

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
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

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

        switch phase {
        case .capturing:
            return
        case .waitChange:
            if wobble > 0.06 || (capQuad.map { $0.maxDist(q) > 0.12 } ?? false) { disturbed = true }
            guard stable && inFrame else { setHint(S("next", "✓ Tamam — sonraki sayfa")); return }
            let sig = Self.signature(CIImage(cvPixelBuffer: pb), q)
            let d = (sig != nil && lastSig != nil) ? Self.sigDiff(sig!, lastSig!) : 9
            if d > 0.55 || (disturbed && d > 0.40) {
                note(String(format: "yeni sayfa (içerik farkı %.2f%@)", d, disturbed ? ", hareket" : ""))
                phase = .hunting; disturbed = false
            } else { setHint(S("next", "✓ Tamam — sonraki sayfa")); return }
            fallthrough
        case .hunting:
            if !inFrame { setHint(S("corners", "Dört köşe kadrajda olsun — telefonu biraz uzaklaştır"), warn: true); return }
            if !stable { setHint(S("hold", "Sabit tut — çekiliyor…")); return }
            lastSig = Self.signature(CIImage(cvPixelBuffer: pb), q)
            capQuad = q
            phase = .capturing
            setHint(S("hold", "Sabit tut — çekiliyor…"))
            note(String(format: "çekim (sayfa görünür→sabit %.2f sn, model %.0f ms)", now - visibleSince, visionMs))
            let s = AVCapturePhotoSettings()
            s.photoQualityPrioritization = .balanced
            s.maxPhotoDimensions = photoOut.maxPhotoDimensions
            DispatchQueue.main.async {
                self.pending += 1
                self.photoOut.capturePhoto(with: s, delegate: self)
            }
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
        videoQueue.async { self.phase = .waitChange; self.disturbed = false }
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
