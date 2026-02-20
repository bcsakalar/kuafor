# Berber & Güzellik Salonu — Uçtan Uca Sistem

**Unisex berber ve güzellik salonu** için tek bir uygulama altında toplanmış **randevu yönetimi**, **kurumsal web sitesi** ve **e-ticaret (online mağaza)** sistemi. Node.js, Express, EJS ve PostgreSQL ile geliştirilmiş, production ortamında PM2 + Nginx + Docker ile çalışacak şekilde tasarlanmıştır.

---

## 📋 İçindekiler

- [Sistem Özeti](#-sistem-özeti)
- [Mimari ve Teknoloji](#-mimari-ve-teknoloji)
- [Modüller ve Akışlar](#-modüller-ve-akışlar)
- [URL Yapısı ve Routing](#-url-yapısı-ve-routing)
- [Veritabanı](#-veritabanı)
- [Kurulum](#-kurulum)
- [Ortam Değişkenleri](#-ortam-değişkenleri)
- [Scriptler](#-scriptler)
- [Production ve Sunucu](#-production-ve-sunucu)
- [Güvenlik ve Loglama](#-güvenlik-ve-loglama)
- [Entegrasyonlar](#-entegrasyonlar)
- [Lisans ve Katkı](#-lisans-ve-katkı)

---

## 🎯 Sistem Özeti

Bu proje tek bir codebase ile şunları sunar:

| Modül | Açıklama |
|-------|----------|
| **Kurumsal site** | Ana domain: hakkımızda, hizmetler, galeri, iletişim, personel sayfaları. |
| **Randevu (booking)** | Müşteri hizmet seçer → personel seçer → müsait saatleri görür → randevu oluşturur. Berber / güzellik için ayrı kategoriler (`/berber/booking`, `/guzellik/booking`). |
| **Admin panel** | Subdomain (`admin.*`): randevu takvimi, personel/hizmet/çalışma saatleri, ayarlar, iletişim kutusu, Google OAuth, medya. |
| **Online mağaza (shop)** | Subdomain (`shop.*`): ürün listesi, sepet, ödeme (Iyzico), sipariş takibi, Google/email ile giriş. |
| **Shop Admin** | Subdomain (`shopadmin.*`): siparişler, ürün/varyant/stok, iptal talepleri, iletişim, raporlar. |

Tüm bu modüller **aynı veritabanı** ve **aynı session store** (PostgreSQL) kullanır; subdomain ve path’e göre tek Express uygulaması içinde yönlendirilir.

---

## 🏗 Mimari ve Teknoloji

- **Backend:** Node.js, Express 4.x  
- **View:** EJS, express-ejs-layouts  
- **Veritabanı:** PostgreSQL 16 (Docker ile çalıştırılabilir)  
- **Session:** connect-pg-simple (PostgreSQL’de session saklama)  
- **Ödeme:** Iyzico (Iyzipay) — 3D Secure, callback, iade akışı  
- **E-posta:** Brevo (Transactional API), SMTP kullanılmıyor  
- **Frontend:** Tailwind CSS (PostCSS ile build), vanilla JS, Socket.IO (isteğe bağlı realtime)  
- **Sunucu (prod):** PM2 (uygulama), Nginx (reverse proxy, SSL), Docker (sadece Postgres; uygulama host’ta)

```
[İstemci] → Nginx (HTTPS) → Node (Express) → PostgreSQL
                ↓
         admin.* / shop.* / shopadmin.* / ana domain
                ↓
         publicRoutes, bookingRoutes, adminRoutes, shopRoutes, shopAdminRoutes
```

---

## 📦 Modüller ve Akışlar

### 1. Kurumsal site (public)

- **Routes:** `publicRoutes` (/, /hakkimizda, /hizmetler, /galeri, /iletisim, /personel vb.)  
- **Controller:** `pagesController`  
- Ana domain’de çalışır; admin subdomain’de bu sayfalar 404 döner.

### 2. Randevu (booking)

- **Path’ler:** `/booking`, `/berber/booking` (erkek), `/guzellik/booking` (kadın)  
- **API:**  
  - `GET /api/services` — kategoriye göre hizmetler  
  - `GET /api/staff` — personel listesi  
  - `GET /api/availability` — seçilen tarih/personel/hizmete göre müsait slotlar  
  - `POST /api/booking` (veya path’e göre) — randevu oluşturma  
- **Çalışma saatleri:** `business_hours` (haftalık) + `business_day_overrides` (tarih bazlı tatil/yarım gün). Müsaitlik bu kurallara göre hesaplanır.  
- **Constraint:** Aynı personel için aynı anda sadece bir `booked` randevu (PostgreSQL `EXCLUDE` constraint).  
- **E-posta:** Randevu onayı ve hatırlatma mailleri (Brevo şablonları).  
- **Arka plan işleri:**  
  - Geçen randevular otomatik `completed` yapılır.  
  - Belirli gün sonrası eski randevular silinir (`PAST_APPOINTMENTS_RETENTION_DAYS`).

### 3. Admin panel

- **Erişim:** Sadece **admin subdomain** (`admin.<domain>` veya `admin.localhost:5001`). `/admin` path’i kapalıdır.  
- **Özellikler:**  
  - Giriş (e-posta/şifre), oturum  
  - Dashboard, takvim (sadece `booked` randevular; tamamlananlar takvimden düşer)  
  - Randevu düzenleme/iptal, personel/hizmet CRUD  
  - Ayarlar: çalışma saatleri, gün bazlı istisnalar, şirket bilgileri  
  - İletişim kutusu, medya yönetimi  
  - Google OAuth (takvim entegrasyonu): randevu ↔ Google Calendar event senkronu (best-effort)  
- **API:** `adminApiRoutes` — takvim, randevu, personel, hizmet, ayarlar vb.  
- **Geçici dev hesabı:** `.env` dosyasındaki `ADMIN_EMAIL` / `ADMIN_PASSWORD` değişkenleri ile yapılandırılır.

### 4. Online mağaza (shop)

- **Erişim:** **Shop subdomain** (`shop.<domain>` veya `shop.localhost:5001`).  
- **Akış:**  
  - Ürün listesi → ürün detay (beden/renk seçimi, varyant stok) → sepete ekleme  
  - Sepet → checkout (teslimat adresi, iletişim) → Iyzico ödeme sayfası  
  - 3D Secure sonrası callback → sipariş durumu güncellenir (bazen arka planda payment sync job ile)  
- **Kullanıcı:** Kayıt/giriş (e-posta + şifre veya Google OAuth). Müşteri bilgisi `customers` tablosunda tutulur; siparişler `orders` + `order_items` ile ilişkilendirilir.  
- **Stok:** Ürün bazlı veya varyant bazlı (`product_variants`); düşük stok uyarısı (Brevo) ve stok hareket logu (`product_stock_events`) mevcut.  
- **Yasal:** Mesafeli satış, iptal/iade, gizlilik sayfaları; ETBIS/şirket bilgileri ayarlardan gelir.

### 5. Shop Admin

- **Erişim:** **Shop Admin subdomain** (`shopadmin.<domain>`).  
- **Özellikler:**  
  - Sipariş listesi, detay, durum güncelleme (kargo kodu vb.)  
  - İptal talepleri (onay/red, e-posta bildirimleri)  
  - Ürün/varyant/stok yönetimi, düşük stok uyarıları  
  - İletişim kutusu, raporlar (analitik API’ler)  
- **Auth:** Kendi login’i; admin panelinden farklıdır.

---

## 🌐 URL Yapısı ve Routing

| Ortam | Ana site | Randevu | Admin | Mağaza | Mağaza Admin |
|-------|----------|---------|-------|--------|--------------|
| **Local** | `http://localhost:5001/` | `/booking`, `/berber/booking`, `/guzellik/booking` | `http://admin.localhost:5001/` | `http://shop.localhost:5001/` | `http://shopadmin.localhost:5001/` |
| **Production** | `https://<domain>/` | Aynı path’ler | `https://admin.<domain>/` | `https://shop.<domain>/` | `https://shopadmin.<domain>/` |

- Admin paneli **path ile değil**, **host (subdomain)** ile ayrılır; böylece tek bir Nginx vhost ile tüm subdomain’ler Node’a proxy edilir.  
- Ödeme callback’leri: `/payment-callback`, `/shop/payment-callback` — Iyzico 3D Secure iframe’inden çağrılır; Nginx’te bu path’ler için ayrı `location` (timeout, X-Frame-Options) tanımlanabilir.

---

## 🗄 Veritabanı

- **PostgreSQL 16**; şema ve seed `sql/init.sql` ile oluşturulur. İlk container ayağa kalktığında `docker-entrypoint-initdb.d` bu dosyayı çalıştırır.  
- **Güncelleme:** Container daha önce oluşturulduysa `init.sql` tekrar çalışmaz. Yeni tablo/kolon için:  
  - Geliştirme: `npm run db:migrate`  
  - Production: `npm run db:migrate:prod`  
- **Performans:** `sql/04-performance-indexes.sql` — sipariş, randevu, ürün, stok sorguları için index’ler.  
  - Geliştirme: `npm run db:indexes`  
  - Production: `npm run db:indexes:prod`  

**Başlıca tablolar:**

| Alan | Tablolar |
|------|----------|
| **Randevu** | `appointments`, `appointment_services`, `customers`, `staff`, `services`, `business_hours`, `business_day_overrides` |
| **E-ticaret** | `products`, `product_variants`, `categories`, `orders`, `order_items`, `order_refunds`, `product_stock_events` |
| **Shop kullanıcı** | `customers` (shop girişi de bu tabloyu kullanır), session’lar `sessions` |
| **Admin** | `admins`, `google_oauth_tokens`, `settings` |
| **İletişim** | `public_contact`, `shop_contact` (ve ilgili mesaj tabloları) |

Şema detayı için `sql/init.sql` dosyasına bakın.

---

## 🚀 Kurulum

### Gereksinimler

- Node.js (LTS önerilir)  
- npm  
- Docker & Docker Compose (PostgreSQL için)  
- (Production) Nginx, PM2  

### Adımlar

1. **Depoyu klonlayın ve bağımlılıkları yükleyin:**

   ```bash
   git clone <repo-url>
   cd berber
   npm install
   ```

2. **Ortam dosyalarını hazırlayın:**  
   Uygulama `NODE_ENV` değerine göre `.env.development` veya `.env.production` yükler.  
   - Geliştirme: `.env.development`  
   - Production: `.env.production`  
   Gerekli değişkenler için [Ortam Değişkenleri](#-ortam-değişkenleri) bölümüne bakın.

3. **PostgreSQL’i Docker ile başlatın:**

   ```bash
   docker compose --env-file .env.development up -d db
   ```

4. **Mevcut DB’yi güncellemek isterseniz (ilk kurulumda gerekmez):**

   ```bash
   npm run db:migrate
   npm run db:indexes
   ```

5. **Uygulamayı çalıştırın:**  
   - Geliştirme: `npm run dev`  
   - Production: `npm start`  

**URL’ler (local):**

- Site: http://localhost:5001/  
- Admin: http://admin.localhost:5001/  
- Mağaza: http://shop.localhost:5001/  
- Shop Admin: http://shopadmin.localhost:5001/  

*(Local’de subdomain için `hosts` dosyasına `127.0.0.1 admin.localhost` vb. eklemeniz gerekebilir; birçok sistemde `something.localhost` zaten çözülür.)*

---

## ⚙️ Ortam Değişkenleri

- **DB:** `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (Docker Compose ile uyumlu isimler kullanılır).  
- **Uygulama:** `NODE_ENV`, `PORT` (varsayılan 5001), `SESSION_SECRET` (production’da zorunlu ve güçlü olmalı).  
- **Base URL (prod):** `APP_BASE_URL` — CORS ve redirect’lerde kullanılır.  
- **CORS:** `CORS_ORIGIN` — virgülle ayrılmış izin verilen origin listesi.  
- **Güvenlik:** `CSRF_ENABLED=1` (opsiyonel), `CSP_ALLOW_UNSAFE_INLINE` (gerekirse).  
- **E-posta (Brevo):** `BREVO_API_KEY`, `EMAIL_FROM_EMAIL`, `EMAIL_FROM_NAME`, `EMAIL_INFO_EMAIL`, `CONTACT_NOTIFY_TO_EMAIL`.  
- **Iyzico:** `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `IYZICO_BASE_URL` (sandbox/prod).  
- **Randevu:** `PAST_APPOINTMENTS_RETENTION_DAYS` (varsayılan 14).  
- **Shop OAuth:** `SHOP_GOOGLE_REDIRECT_URIS` (virgülle liste).  
- **Host önekleri:** `SHOP_HOSTNAME_PREFIX`, `SHOP_ADMIN_HOSTNAME_PREFIX` (varsayılan `shop.`, `shopadmin.`).  

Detaylı liste ve örnekler için proje kökündeki `.env.example` (varsa) veya `SERVER.md` / `SECURITY.md` dosyalarına bakın.

---

## 📜 Scriptler

| Komut | Açıklama |
|-------|----------|
| `npm run dev` | Geliştirme sunucusu (watch) |
| `npm start` | Production sunucusu |
| `npm run db:migrate` | Şema migrasyonu (development env) |
| `npm run db:migrate:prod` | Şema migrasyonu (production env) |
| `npm run db:indexes` | Performans index’leri (development) |
| `npm run db:indexes:prod` | Performans index’leri (production) |
| `npm run css:build` | Tailwind CSS build → `public/css/tailwind.css` |
| `npm run brevo:test:prod` | Brevo API anahtarını doğrula |
| `npm run brevo:send:prod` | Test e-postası gönder |

---

## 🖥 Production ve Sunucu

- **Mimari:** PM2 (Node uygulaması) + Nginx (reverse proxy, SSL) + Docker (sadece PostgreSQL).  
- **Detaylı adımlar:** `SERVER.md` — ilk kurulum, güncelleme, DB yedekleme/restore, Nginx örnek config, PM2 komutları.  
- **Nginx:** `deploy/nginx/berber.conf` örnek vhost; tüm subdomain’ler tek upstream’e (örn. `127.0.0.1:5001`) proxy edilir.  
- **Tailwind:** CSS’i yerelde `npm run css:build` ile üretip commit edebilirsiniz; sunucuda ek build gerekmez (veya sunucuda bir kez `npm run css:build` çalıştırılabilir).

---

## 🔒 Güvenlik ve Loglama

- **Rate limiting:** Genel API, auth, kayıt, ödeme path’leri için ayrı limitler (`SECURITY.md`).  
- **Helmet:** CSP ve güvenlik header’ları; Iyzico iframe/form için gerekli izinler tanımlı.  
- **CORS:** Production’da `CORS_ORIGIN` ile sınırlı; tanımsızsa cross-origin reddedilir.  
- **Loglama:** Winston; `logs/` altında `combined.log`, `error.log`, `business.log`, `access.log`; rotasyon ve business event’leri (sipariş, stok, randevu vb.).  

Detaylar için **SECURITY.md** dosyasını inceleyin.

---

## 🔌 Entegrasyonlar

- **Brevo (e-posta):** Randevu onayı, hatırlatma, iletişim formu, sipariş/iptal/iade mailleri, düşük stok uyarıları.  
- **Iyzico:** Checkout formu, 3D Secure, callback, iade; ödeme sonrası sipariş durumu bazen arka planda `paymentSync` job ile güncellenir.  
- **Google Calendar:** Admin panelinden OAuth; randevu oluşturma/düzenleme/iptal ile Google event senkronu (personel `google_calendar_id` veya primary).  
- **Google (Shop):** Müşteri girişi için OAuth; `SHOP_GOOGLE_REDIRECT_URIS` ile callback URL’leri tanımlanır.  
- **reCAPTCHA:** İsteğe bağlı; ilgili middleware ve env değişkenleri mevcuttur.

---

## 📄 Lisans ve Katkı

Proje private olarak kullanıma uygundur. Katkı ve lisans detayları repo sahibi tarafından belirlenir.

---

**Özet:** Bu README, Berber & Güzellik Salonu uygulamasının **kurumsal site + randevu + admin + e-ticaret + shop admin** modüllerini, **tek veritabanı ve tek Node uygulaması** ile nasıl bir arada çalıştığını, URL/routing yapısını, kurulum ve production adımlarını özetler. Daha fazla teknik detay için `SERVER.md`, `SECURITY.md` ve `sql/init.sql` dosyalarına bakabilirsiniz.
