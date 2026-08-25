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


// ==========================================
// مسار إرجاع رابط البث المباشر للقناة صيغة JSON
// ==========================================
app.get('/api/live/stream-url/:streamId', (req, res) => {
    try {
        const { streamId } = req.params;
        // يمكنك تحديد الصيغة عبر query string: ?ext=ts أو مبيناً كـ m3u8 افتراضياً
        const extension = req.query.ext || 'm3u8';

        // تركيب رابط البث المباشر المباشر
        const directStreamUrl = `${SERVER_URL}/live/${USERNAME}/${PASSWORD}/${streamId}.${extension}`;

        // إرجاع النتيجة كـ JSON يفهمها تطبيقك
        res.json({
            success: true,
            stream_id: streamId,
            format: extension,
            stream_url: directStreamUrl
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// قسم الأفلام (VOD / Movies)
// ==========================================

// 1. جلب فئات (أقسام) الأفلام
app.get('/api/movies/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_vod_categories`;
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. جلب قائمة الأفلام (كل الأفلام أو حسب category_id)
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

// 3. جلب تفاصيل الفيلم (القصة، الممثلين، التقييم، البوستر، الجودة)
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

// 4. استخراج رابط المشاهدة المباشر للفيلم (صيغة JSON)
app.get('/api/movies/stream-url/:streamId', async (req, res) => {
    try {
        const { streamId } = req.params;
        // الامتداد الافتراضي للأفلام هو mp4 أو mkv حسب القناة (يمكن جلب الامتداد الأصلي من بيانات الفيلم container_extension)
        const containerExtension = req.query.ext || 'mp4';

        // تركيب رابط الفيلم المباشر
        const directMovieUrl = `${SERVER_URL}/movie/${USERNAME}/${PASSWORD}/${streamId}.${containerExtension}`;

        res.json({
            success: true,
            stream_id: streamId,
            extension: containerExtension,
            stream_url: directMovieUrl
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// قسم المسلسلات (Series & Episodes)
// ==========================================

// 1. جلب فئات (أقسام) المسلسلات
app.get('/api/series/categories', async (req, res) => {
    try {
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_categories`;
        const response = await axios.get(url);
        res.json({ success: true, count: response.data.length, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. جلب قائمة المسلسلات (الكل أو حسب الفئة category_id)
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

// 3. جلب تفاصيل مسلسل معين (المواسم + قائمة الحلقات كاملة + القصة والبوستر)
app.get('/api/series/info/:seriesId', async (req, res) => {
    try {
        const { seriesId } = req.params;
        const url = `${SERVER_URL}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_series_info&series_id=${seriesId}`;
        const response = await axios.get(url);
        
        // إرجاع تفاصيل المسلسل مع قائمة الحلقات مقسمة حسب المواسم
        res.json({
            success: true,
            info: response.data.info,
            seasons: response.data.seasons,
            episodes: response.data.episodes // تحتوي على الحلقات ورقم episode_id الخاص بكل حلقة
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. استخراج رابط التشغيل المباشر للحلقة (عبر episode_id و container_extension)
app.get('/api/series/episode-url/:episodeId', (req, res) => {
    try {
        const { episodeId } = req.params;
        // الامتداد الافتراضي للحلقات غالباً mp4 أو mkv
        const extension = req.query.ext || 'mp4';

        // تركيب رابط تشغيل الحلقة المباشر
        const episodeStreamUrl = `${SERVER_URL}/series/${USERNAME}/${PASSWORD}/${episodeId}.${extension}`;

        res.json({
            success: true,
            episode_id: episodeId,
            extension: extension,
            stream_url: episodeStreamUrl
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
