const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// إعدادات السيرفر
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors()); // السماح لجميع التطبيقات والمشغلات بالوصول

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة (Config)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

// بيانات دخول Xtream الخاصة بك (يمكنك تغييرها)
const XTREAM_USER = "fadi";
const XTREAM_PASS = "2026";

// ==========================================
// محرك الكاش (لتخفيف الضغط وتسريع الاستجابة)
// ==========================================
const CacheEngine = {
    memory: new Map(),
    async getOrFetch(key, fetcher, ttlMs) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        
        try {
            const data = await fetcher();
            this.memory.set(key, { data, expiresAt: Date.now() + ttlMs });
            return data;
        } catch (error) {
            if (cached) return cached.data; // إرجاع البيانات القديمة في حال تعطل المصدر
            throw error;
        }
    }
};

// تنظيف الكاش المنتهي كل 60 ثانية
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 60000);

// ==========================================
// 1. مسار Xtream Codes API الأساسي (player_api.php)
// ==========================================
app.get('/player_api.php', async (req, res) => {
    const { username, password, action, category_id } = req.query;

    // أ. التحقق من بيانات الدخول
    if (username !== XTREAM_USER || password !== XTREAM_PASS) {
        return res.json({ user_info: { auth: 0 } });
    }

    // ب. الاستجابة الافتراضية (معلومات السيرفر والتسجيل)
    if (!action) {
        return res.json({
            user_info: {
                username: XTREAM_USER,
                password: XTREAM_PASS,
                message: "Welcome to Yacine API Pro",
                auth: 1,
                status: "Active",
                exp_date: "null",
                is_trial: "0",
                active_cons: 0,
                max_connections: "99"
            },
            server_info: {
                url: req.hostname,
                port: process.env.PORT || "80",
                https_port: "443",
                server_protocol: "http",
                rtmp_port: "1935",
                timestamp_now: Math.floor(Date.now() / 1000),
                time_now: new Date().toISOString().replace('T', ' ').substring(0, 19)
            }
        });
    }

    // ج. إرسال الأقسام (Categories)
    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "1", category_name: "⚽ المباريات المباشرة اليوم", parent_id: 0 },
            { category_id: "2", category_name: "📺 قنوات البث المباشر", parent_id: 0 }
        ]);
    }

    // د. إرسال القنوات حسب القسم (Streams)
    if (action === 'get_live_streams') {
        let streams = [];

        try {
            // جلب المباريات المباشرة (القسم 1)
            if (!category_id || category_id === "1") {
                const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                    const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                    return res.data;
                }, 60000); // كاش لمدة دقيقة

                matches.forEach((match, index) => {
                    let channelStr = match.channel || match.id_live || '';
                    let cleanChannelId = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                    
                    if (cleanChannelId) {
                        streams.push({
                            num: index + 1,
                            name: match.title || match.name || `${match.team1} vs ${match.team2}`,
                            stream_type: "live",
                            stream_id: cleanChannelId, // ID المشغل
                            stream_icon: match.logo || "https://i.imgur.com/rXjJ09Y.png", // لوجو افتراضي
                            category_id: "1"
                        });
                    }
                });
            }

            // جلب قنوات التلفاز (القسم 2)
            if (!category_id || category_id === "2") {
                const tvChannels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
                    const response = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
                    return response.data;
                }, 300000); // كاش لمدة 5 دقائق

                tvChannels.forEach((ch, index) => {
                    streams.push({
                        num: (streams.length || 0) + index + 1,
                        name: ch.name,
                        stream_type: "live",
                        stream_id: `sat_${ch.id}`,
                        stream_icon: ch.logo || "https://i.imgur.com/8Qx2y2q.png",
                        category_id: "2"
                    });
                });
            }
        } catch (e) {
            console.error("Error fetching streams:", e.message);
        }

        return res.json(streams);
    }

    // هـ. استجابة فارغة لأي أقسام غير مدعومة (مثل الأفلام أو المسلسلات)
    return res.json([]);
});

// ==========================================
// 2. مسار تشغيل البث المباشر (Direct M3U8 Generator)
// ==========================================
// نستخدم :file لاستقبال الرابط سواء انتهى بـ .m3u8 أو .ts أو بدون امتداد
app.get('/live/:username/:password/:file', async (req, res) => {
    const { username, password, file } = req.params;

    // أ. التحقق من المستخدم
    if (username !== XTREAM_USER || password !== XTREAM_PASS) {
        return res.status(403).send('#EXTM3U\n#EXT-X-ERROR: Unauthorized User');
    }

    // استخراج الـ ID الحقيقي للقناة بمسح الامتدادات
    const stream_id = file.split('.')[0];
    const isSatChannel = stream_id.startsWith('sat_');
    
    try {
        let serverUrl = null;
        let headers = {
            'User-Agent': CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*'
        };

        // ب. تحديد رابط البث من المصدر
        if (isSatChannel) {
            const id = stream_id.replace('sat_', '');
            const channelData = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${id}.json`, { timeout: 5000 });
            if (channelData.data && channelData.data.servers && channelData.data.servers.length > 0) {
                serverUrl = channelData.data.servers[0].url; // السيرفر الأول
                if (channelData.data.servers[0].headers) headers = { ...headers, ...channelData.data.servers[0].headers };
            }
        } else {
            const apiTarget = `live_tv_${stream_id}`;
            let apiRes = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: apiTarget }, headers, timeout: 5000 }).catch(() => null);
            
            if (!apiRes || !apiRes.data || (Array.isArray(apiRes.data) && apiRes.data.length === 0)) {
                apiRes = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${apiTarget}`, { headers, timeout: 5000 }).catch(() => null);
            }

            const dataArray = Array.isArray(apiRes?.data) ? apiRes.data : [apiRes?.data];
            for (const srv of dataArray) {
                if (srv && srv.data && srv.data.url) {
                    let rawUrl = srv.data.url;
                    try {
                        let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() };
                        serverUrl = innerData.url;
                        if (innerData.headers) headers = { ...headers, ...innerData.headers };
                        break;
                    } catch (e) { serverUrl = rawUrl; break; }
                }
            }
        }

        if (!serverUrl) return res.status(404).send('#EXTM3U\n#EXT-X-ERROR: Stream not found or offline');

        // ج. جلب محتوى ملف m3u8 وتحويل الروابط
        headers['Referer'] = new URL(serverUrl).origin + '/';
        headers['Origin'] = new URL(serverUrl).origin;

        const m3u8Response = await axios.get(serverUrl, { headers, timeout: 8000 });
        const finalUrl = m3u8Response.request.res.responseUrl || serverUrl;
        
        // د. تحويل مسارات الفيديو (.ts) إلى روابط كاملة للمصدر الأصلي
        let lines = m3u8Response.data.split('\n');
        let rewrittenLines = lines.map(line => {
            let trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return trimmed;
            
            try { 
                return new URL(trimmed, finalUrl).href; 
            } catch (e) { 
                return trimmed; 
            }
        });

        // إرجاع الملف الجاهز للمشغل
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenLines.join('\n'));

    } catch (error) {
        console.error(`[Stream Error] ${stream_id}:`, error.message);
        res.status(500).send('#EXTM3U\n#EXT-X-ERROR: Source Stream Unavailable');
    }
});

// ==========================================
// مسار التأكد من عمل السيرفر
// ==========================================
app.get('/', (req, res) => {
    res.json({
        name: "Yacine Xtream Emulator",
        status: "Online",
        developer: "Fadi Alatawna",
        message: "Use player_api.php for Xtream Codes connection."
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Xtream API Server is running on port ${PORT}`);
});
