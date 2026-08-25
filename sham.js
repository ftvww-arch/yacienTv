const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// ثوابت الاتصال
const SERVER_URL = 'http://orien.live';
const USERNAME = '16304575049793';
const PASSWORD = '43581893985883';

// إعداد الكاش (التخزين المؤقت): يحفظ البيانات لمدة 12 ساعة (43200 ثانية)
const cache = new NodeCache({ stdTTL: 43200 });

// دالة مساعدة لجلب البيانات من السيرفر أو من الكاش لتقليل الضغط
async function fetchWithCache(cacheKey, url) {
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        return cachedData; // إرجاع البيانات المحفوظة فوراً
    }
    const response = await axios.get(url);
    cache.set(cacheKey, response.data); // حفظ البيانات الجديدة في الكاش
    return response.data;
}

// ==========================================
// 1. قسم القنوات الحية (TV)
// ==========================================

// أقسام القنوات
app.get('/api/tv/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_categories`;
        const data = await fetchWithCache('tv_categories', url);
        res.json(data); // إرجاع مصفوفة بسيطة [ {...}, {...} ]
    } catch (error) { res.status(500).send("Error"); }
});

// القنوات داخل قسم معين
app.get('/api/tv/categories/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_streams&category_id=${req.params.id}`;
        const data = await fetchWithCache(`tv_cat_${req.params.id}`, url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// رابط مشاهدة القناة (نص صافي)
app.get('/api/tv/stream/:id', (req, res) => {
    const streamUrl = `${SERVER_URL}/live/${USERNAME}/${PASSWORD}/${req.params.id}.m3u8`;
    res.send(streamUrl); 
});

// ==========================================
// 2. قسم الأفلام (Movies)
// ==========================================

// أقسام الأفلام
app.get('/api/movies/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_categories`;
        const data = await fetchWithCache('movies_categories', url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// الأفلام داخل قسم معين
app.get('/api/movies/category/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_streams&category_id=${req.params.id}`;
        const data = await fetchWithCache(`movies_cat_${req.params.id}`, url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// معلومات الفيلم
app.get('/api/movies/info/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_info&vod_id=${req.params.id}`;
        const data = await fetchWithCache(`movie_info_${req.params.id}`, url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// رابط مشاهدة الفيلم (نص صافي)
app.get('/api/movies/stream/:id', (req, res) => {
    // يمكنك تمرير الامتداد عبر ?ext=mkv وإلا سيكون mp4 افتراضياً
    const ext = req.query.ext || 'mp4'; 
    const streamUrl = `${SERVER_URL}/movie/${USERNAME}/${PASSWORD}/${req.params.id}.${ext}`;
    res.send(streamUrl);
});

// ==========================================
// 3. قسم المسلسلات (Series)
// ==========================================

// أقسام المسلسلات
app.get('/api/series/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_categories`;
        const data = await fetchWithCache('series_categories', url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// المسلسلات داخل قسم معين
app.get('/api/series/category/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series&category_id=${req.params.id}`;
        const data = await fetchWithCache(`series_cat_${req.params.id}`, url);
        res.json(data);
    } catch (error) { res.status(500).send("Error"); }
});

// معلومات المسلسل العامة
app.get('/api/series/info/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_info&series_id=${req.params.id}`;
        const data = await fetchWithCache(`series_info_${req.params.id}`, url);
        res.json(data.info || {}); // يرجع تفاصيل المسلسل فقط بصيغة بسيطة
    } catch (error) { res.status(500).send("Error"); }
});

// مواسم المسلسل
app.get('/api/series/sezon/:id', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_info&series_id=${req.params.id}`;
        const data = await fetchWithCache(`series_info_${req.params.id}`, url); // جلب من الكاش
        res.json(data.seasons || []); // يرجع مصفوفة المواسم فقط [ {...} ]
    } catch (error) { res.status(500).send("Error"); }
});

// حلقات موسم معين (يحتاج معرف المسلسل ومعرف الموسم)
// المسار: /api/series/eclips/رقم_المسلسل/رقم_الموسم
app.get('/api/series/eclips/:seriesId/:seasonNum', async (req, res) => {
    try {
        const { seriesId, seasonNum } = req.params;
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_info&series_id=${seriesId}`;
        const data = await fetchWithCache(`series_info_${seriesId}`, url); // جلب من الكاش بسرعة
        
        // جلب حلقات الموسم المطلوب فقط وإرجاعها كمصفوفة بسيطة
        const episodes = data.episodes ? (data.episodes[seasonNum] || []) : [];
        res.json(episodes);
    } catch (error) { res.status(500).send("Error"); }
});

// رابط مشاهدة الحلقة (نص صافي)
app.get('/api/series/stream/:id', (req, res) => {
    const ext = req.query.ext || 'mp4';
    const streamUrl = `${SERVER_URL}/series/${USERNAME}/${PASSWORD}/${req.params.id}.${ext}`;
    res.send(streamUrl);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
