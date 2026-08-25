const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// استخراج البورت الموفر من بيئة تشغيل Render
const PORT = process.env.PORT || 3000;

// ثوابت الاتصال بسيرفر الـ Xtream
const SERVER_URL = 'http://orien.live';
const USERNAME = '16304575049793';
const PASSWORD = '43581893985883';

// ==========================================
// وحدة الحساب (Account Info)
// ==========================================
app.get('/api/account/info', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}`;
        const response = await axios.get(url);
        res.json({
            success: true,
            description: "معلومات الاشتراك وحالة الحساب والاتصالات",
            data: response.data
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 1. قسم القنوات الحية (Live TV)
// ==========================================

// أ. جلب فئات القنوات الحية
app.get('/api/live/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_categories`;
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ب. جلب جميع القنوات الحية أو حسب الفئة
app.get('/api/live/streams', async (req, res) => {
    try {
        const { category_id } = req.query;
        let url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_streams`;
        if (category_id) {
            url += `&category_id=${category_id}`;
        }
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 2. قسم الأفلام (VOD / Movies)
// ==========================================

// أ. جلب فئات الأفلام
app.get('/api/movies/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_categories`;
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ب. جلب الأفلام (الكل أو حسب الفئة)
app.get('/api/movies/streams', async (req, res) => {
    try {
        const { category_id } = req.query;
        let url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_streams`;
        if (category_id) {
            url += `&category_id=${category_id}`;
        }
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ج. جلب معلومات فيلم معين عبر الـ vod_id
app.get('/api/movies/info/:vodId', async (req, res) => {
    try {
        const { vodId } = req.params;
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_info&vod_id=${vodId}`;
        const response = await axios.get(url);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 3. قسم المسلسلات (Series)
// ==========================================

// أ. جلب فئات المسلسلات
app.get('/api/series/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_categories`;
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ب. جلب المسلسلات (الكل أو حسب الفئة)
app.get('/api/series/streams', async (req, res) => {
    try {
        const { category_id } = req.query;
        let url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series`;
        if (category_id) {
            url += `&category_id=${category_id}`;
        }
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ج. جلب تفاصيل المسلسل عبر الـ series_id
app.get('/api/series/info/:seriesId', async (req, res) => {
    try {
        const { seriesId } = req.params;
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_info&series_id=${seriesId}`;
        const response = await axios.get(url);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
