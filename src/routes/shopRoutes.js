const express = require('express');
const shopController = require('../controllers/shopController');
const authController = require('../controllers/authController');
const { attachShopUser, requireShopLogin } = require('../middleware/shopAuth');
const { authLimiter, registrationLimiter, paymentLimiter, shopContactLimiter } = require('../middleware/rateLimiter');
const { authValidation, shopValidation, validateRequest } = require('../middleware/validators');

const router = express.Router();

router.use(attachShopUser);

router.get('/login', authController.renderShopLogin);
router.post('/login', authLimiter, authValidation.login, validateRequest, authController.login);

router.get('/forgot-password', authController.renderForgotPassword);
router.post('/forgot-password', authLimiter, authController.forgotPassword);

router.get('/reset-password/:token', authController.renderResetPassword);
router.post('/reset-password/:token', authLimiter, authController.resetPassword);

router.get('/register', authController.renderShopRegister);
router.post('/register', registrationLimiter, authValidation.register, validateRequest, authController.register);

router.get('/auth/google', authController.beginGoogleLogin);
router.get('/auth/google/callback', authController.finishGoogleLogin);
router.get('/auth/google/complete', authController.completeGoogleLogin);

router.post('/logout', authController.logout);

router.get('/', shopController.renderShopHome);
router.get('/products', shopController.renderShopProducts);
router.get('/product/:id', shopController.renderProduct);

router.get('/cart', shopController.renderCart);
router.post('/cart/add', shopController.addToCart);
router.post('/cart/remove', shopController.removeFromCart);
router.post('/cart/update', shopController.updateCartItem);

router.get('/checkout', requireShopLogin, shopController.renderCheckout);
router.post('/checkout', requireShopLogin, paymentLimiter, shopController.placeOrder);
router.get('/checkout/hosted', requireShopLogin, shopController.redirectToHostedPayment);

// Intermediate redirect page (improves mobile/WebView reliability)
router.get('/payment-redirect', shopController.renderPaymentRedirect);

// Success page (GET) after payment callback uses PRG to avoid POST refresh warnings.
router.get('/order-success', shopController.renderOrderSuccess);

// Lightweight status endpoint for 3DS redirect reliability (checkout polling)
router.get('/order-status', requireShopLogin, shopController.getOrderPaymentStatus);

// Iyzipay callback after checkout form payment
// Note: Should not require login (Iyzico posts back to our server)
router.post('/shop/payment-callback', paymentLimiter, shopController.paymentCallback);
router.get('/shop/payment-callback', paymentLimiter, shopController.paymentCallbackGet);
// Backwards/short alias (useful for local testing)
router.post('/payment-callback', paymentLimiter, shopController.paymentCallback);
router.get('/payment-callback', paymentLimiter, shopController.paymentCallbackGet);

router.get('/track', shopController.renderOrderTracking);

router.get('/account', requireShopLogin, shopController.renderMyAccount);
router.get('/orders', requireShopLogin, shopController.renderMyOrders);

router.post('/account/orders/:id/cancel', requireShopLogin, shopController.cancelOrder);

router.get('/hakkimizda', shopController.renderShopAbout);
router.get('/iletisim', shopController.renderShopContact);
router.post('/iletisim', shopContactLimiter, shopValidation.contact, validateRequest, shopController.submitShopContact);

router.get('/privacy', shopController.renderPrivacyPolicy);
router.get('/cookies', shopController.renderCookiePolicy);
router.get('/shipping-returns', shopController.renderShippingReturns);

router.get('/sozlesmeler/mesafeli-satis', shopController.renderDistanceSales);
router.get('/sozlesmeler/gizlilik', shopController.renderLegalPrivacyPolicy);
router.get('/sozlesmeler/iptal-iade', shopController.renderCancellationRefund);

module.exports = router;
