const express = require('express');
const googleCalendar = require('../services/googleCalendar');

const router = express.Router();

router.get('/auth', async (req, res, next) => {
	try {
		const url = await googleCalendar.getAuthUrl(req);
		if (!url) {
			return res.status(400).render('admin/google', {
				title: 'Google Entegrasyonu',
				layout: 'layouts/admin',
				error: 'Google Client ID/Secret/Redirect URI eksik. `.env` dosyasına ekleyin veya admin ekranından kaydedin.',
			});
		}
		return res.redirect(url);
	} catch (err) {
		next(err);
	}
});

router.get('/callback', async (req, res, next) => {
	try {
		const code = req.query.code;
		if (!code) return res.status(400).send('Missing code');
		await googleCalendar.handleOAuthCallback(code, req);
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		return res.redirect(base ? `${base}/google?ok=1` : '/google?ok=1');
	} catch (err) {
		next(err);
	}
});

module.exports = router;
