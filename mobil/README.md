# INSTANT SCANNER — iPhone uygulaması

Web uygulamasının (proje kökündeki `index.html` + `core.js`) Capacitor ile iPhone
uygulaması olarak paketlenmiş hâli. Tek kaynak kök klasördeki dosyalardır; bu
klasör yalnızca iOS kabuğunu içerir.

## Uygulamada web sürümünden farklı olanlar

- PDF, iPhone paylaşım menüsüyle açılır (Dosyalara Kaydet, WhatsApp, Mail, Yazdır…).
  Oluşturulan PDF'ler ve yarım kalan tarama (web sürümünde de) cihazda saklanır;
  "Önceki taramalar" listesinden yeniden açılır.
- Her sayfa çekildiğinde telefon hafifçe titrer (dokunsal geri bildirim).
- Uygulama açıkken ekran kendiliğinden kararmaz.
- Service worker kullanılmaz; dosyalar zaten cihazdadır, internet gerekmez.
- Yalnız iPhone, yalnız dikey ekran, koyu görünüm.

## Derleme

Derleme bulutta, GitHub Actions'taki macOS makinesinde yapılır (`.github/workflows/ios.yml`).
`index.html`, `core.js` ya da `mobil/` değiştiğinde ve master'a gönderildiğinde kendiliğinden
çalışır. GitHub → Actions → "iOS derleme" → **Run workflow** ile elle de başlatılabilir.
Sonuç: Artifacts altında `InstantScanner-imzasiz-ipa` (imzasız .ipa).

Yerelde web dosyalarını iOS projesine aktarmak için:

```
cd mobil
npm install
npm run sync
```

## Developer hesabı olmadan iPhone'da denemek

İmzasız .ipa, ücretsiz Apple ID ile Windows'tan yüklenebilir (ör. Sideloadly).
Ücretsiz imza 7 gün geçerlidir, sonra yeniden yüklemek gerekir. iPhone'da
Ayarlar → Gizlilik ve Güvenlik → Geliştirici Modu açık olmalıdır.

## Apple Developer hesabı alınınca

1. App Store Connect'te uygulama kaydı aç. Paket kimliği: `io.github.devrimozaydin72.instantscanner`
   (ilk gönderimden önce `capacitor.config.json` ve Xcode projesinde değiştirilebilir, sonra değişmez).
2. App Store Connect API anahtarı oluştur ve GitHub deposuna gizli değişken (secret) olarak ekle.
3. İş akışına imzalı derleme + TestFlight yükleme adımı eklenir; Mac gerekmez.
