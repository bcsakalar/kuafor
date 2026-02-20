const rateLimit = require('express-rate-limit');

// Genel API rate limiter
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 dakika
	max: 100, // 15 dakikada maksimum 100 istek
	message: { error: 'Çok fazla istek gönderdiniz, lütfen daha sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Kimlik doğrulama için daha sıkı limiter
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 dakika
	max: 5, // 15 dakikada maksimum 5 deneme
	message: { error: 'Çok fazla giriş denemesi yaptınız, lütfen 15 dakika sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
	skipSuccessfulRequests: true, // Başarılı istekleri sayma
});

// Ödeme işlemleri için limiter
const paymentLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 dakika
	max: 10, // 15 dakikada maksimum 10 ödeme işlemi
	message: { error: 'Çok fazla ödeme işlemi gerçekleştirdiniz, lütfen daha sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Kayıt işlemleri için limiter
const registrationLimiter = rateLimit({
	windowMs: 60 * 60 * 1000, // 1 saat
	max: 3, // Saatte maksimum 3 kayıt
	message: { error: 'Çok fazla kayıt denemesi yaptınız, lütfen daha sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Public contact form limiter (anti-spam)
const publicContactLimiter = rateLimit({
	windowMs: 10 * 60 * 1000, // 10 dakika
	max: 5, // 10 dakikada maksimum 5 mesaj
	message: { error: 'Çok fazla mesaj gönderdiniz, lütfen daha sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Shop contact form limiter (anti-spam)
const shopContactLimiter = rateLimit({
	windowMs: 10 * 60 * 1000, // 10 dakika
	max: 5, // 10 dakikada maksimum 5 mesaj
	message: { error: 'Çok fazla mesaj gönderdiniz, lütfen daha sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Randevu API rate limiter (spam/DoS koruması)
const bookingLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 dakika
	max: 5, // 15 dakikada maksimum 5 randevu talebi
	message: { error: 'Çok fazla randevu talebi gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.' },
	standardHeaders: true,
	legacyHeaders: false,
	keyGenerator: (req) => {
		// IP + telefon numarası kombinasyonu ile rate limit
		const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
		const phone = String(req.body?.customerPhone || '').replace(/\D/g, '').slice(-10);
		return phone ? `${ip}:${phone}` : ip;
	},
});

// Randevu müsaitlik sorgusu rate limiter
const bookingAvailabilityLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, // 1 dakika
	max: 30, // Dakikada maksimum 30 müsaitlik sorgusu
	message: { error: 'Çok fazla sorgu yaptınız. Lütfen biraz bekleyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Ürün listeleme rate limiter (DoS koruması)
const productListingLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, // 1 dakika
	max: 60, // Dakikada maksimum 60 ürün listesi isteği
	message: { error: 'Çok fazla istek gönderdiniz. Lütfen biraz bekleyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Sipariş arama/filtreleme rate limiter
const orderSearchLimiter = rateLimit({
	windowMs: 1 * 60 * 1000, // 1 dakika
	max: 30, // Dakikada maksimum 30 arama
	message: { error: 'Çok fazla arama yaptınız. Lütfen biraz bekleyin.' },
	standardHeaders: true,
	legacyHeaders: false,
});

module.exports = {
	apiLimiter,
	authLimiter,
	paymentLimiter,
	registrationLimiter,
	publicContactLimiter,
	shopContactLimiter,
	bookingLimiter,
	bookingAvailabilityLimiter,
	productListingLimiter,
	orderSearchLimiter,
};
