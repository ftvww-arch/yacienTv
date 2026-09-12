const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// إعدادات السيرفر
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors()); // السماح لأي تطبيق بالوصول للـ API

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة (Config)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

// ==========================================
// محرك الكاش (لتقليل الضغط على المصادر وتسريع الـ API)
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
            if (cached) return cached.data; // إرجاع القديم في حال الفشل
            throw error;
        }
    }
};

// تنظيف الكاش منتهي الصلاحية
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 60000);

// ==========================================
// 1. مسار الأقسام (Categories / Topics)
// ==========================================
app.get('/get-all-topics', (req, res) => {
    // تم تثبيت قسم المباريات ليكون الأول دائماً (ID: 1)
    const topics = [
        { topic_id: "1", topic_name: "⚽ المباريات المباشرة اليوم" },
        { topic_id: "2", topic_name: "📺 قنوات البث المباشر (عامة)" }
    ];
    
    res.json({
        status: "success",
        count: topics.length,
        data: topics
    });
});

// ==========================================
// 2. مسار القنوات حسب القسم (Channels by Topic)
// ==========================================
app.get('/channels', async (req, res) => {
    const topicId = req.query.topic;
    const hostUrl = `https://${req.get('host')}`;
    let channels = [];

    try {
        if (topicId === "1") {
            // جلب المباريات المباشرة
            const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                return res.data;
            }, 60000); // كاش لمدة دقيقة للمباريات

            channels = matches.map(match => {
                let channelStr = match.channel || match.id_live || '';
                let cleanChannelId = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                
                return {
                    channel_id: `match_${cleanChannelId}`,
                    name: match.title || match.name || `${match.team1} vs ${match.team2}`,
                    icon: match.logo || "", // يمكنك إضافة رابط لوجو افتراضي هنا
                    // هذا هو الرابط المباشر الذي ستضعه في ExoPlayer
                    stream_url: cleanChannelId ? `${hostUrl}/live/${cleanChannelId}.m3u8` : null,
                    details: match // بيانات إضافية للتطبيق (وقت، معلق، بطولة)
                };
            }).filter(ch => ch.stream_url !== null);

        } else if (topicId === "2") {
            // جلب القنوات الثابتة من جيت هب
            const tvChannels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
                const response = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
                return response.data;
            }, 300000); // كاش 5 دقائق للقنوات

            channels = tvChannels.map(ch => ({
                channel_id: `sat_${ch.id}`,
                name: ch.name,
                icon: ch.logo || "", 
                stream_url: `${hostUrl}/live/sat_${ch.id}.m3u8`
            }));
        } else {
            return res.status(404).json({ status: "error", message: "القسم غير موجود" });
        }

        res.json({
            status: "success",
            topic_id: topicId,
            count: channels.length,
            data: channels
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "حدث خطأ أثناء جلب القنوات" });
    }
});

// ==========================================
// 3. مسار استخراج الرابط المباشر (Direct M3U8 Generator)
// ==========================================
app.get('/live/:id.m3u8', async (req, res) => {
    const channelId = req.params.id;
    const isSatChannel = channelId.startsWith('sat_');
    
    try {
        let serverUrl = null;
        let headers = {
            'User-Agent': CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*'
        };

        // أ. جلب رابط السيرفر المناسب
        if (isSatChannel) {
            const id = channelId.replace('sat_', '');
            const channelData = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${id}.json`, { timeout: 5000 });
            if (channelData.data && channelData.data.servers && channelData.data.servers.length > 0) {
                serverUrl = channelData.data.servers[0].url; // اختيار السيرفر الأول
                if (channelData.data.servers[0].headers) {
                    headers = { ...headers, ...channelData.data.servers[0].headers };
                }
            }
        } else {
            const apiTarget = `live_tv_${channelId}`;
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
                        break; // أخذ أول سيرفر شغال
                    } catch (e) { serverUrl = rawUrl; break; }
                }
            }
        }

        if (!serverUrl) return res.status(404).send('Stream not found');

        // ب. جلب محتوى الـ M3U8 وتهيئته
        headers['Referer'] = new URL(serverUrl).origin + '/';
        headers['Origin'] = new URL(serverUrl).origin;

        const m3u8Response = await axios.get(serverUrl, { headers, timeout: 8000 });
        let m3u8Content = m3u8Response.data;

        // ج. تحويل الروابط النسبية (Relative) إلى روابط مطلقة (Absolute)
        // هذا يسمح للمشغل (ExoPlayer) بسحب قطع الـ ts من المصدر الأصلي مباشرة دون استهلاك موارد سيرفرك
        const finalUrl = m3u8Response.request.res.responseUrl || serverUrl;
        
        let lines = m3u8Content.split('\n');
        let rewrittenLines = lines.map(line => {
            let trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return trimmed;
            
            // تحويل المسار النسبي إلى رابط كامل
            try {
                return new URL(trimmed, finalUrl).href;
            } catch (e) {
                return trimmed;
            }
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenLines.join('\n'));

    } catch (error) {
        console.error(`[Stream Error] ${channelId}:`, error.message);
        res.status(500).send('#EXTM3U\n#EXT-X-ERROR: Stream Unavailable');
    }
});

// ==========================================
// مسار التأكد من عمل السيرفر
// ==========================================
app.get('/', (req, res) => {
    res.json({
        name: "Yacine API Pro",
        status: "active",
        endpoints: {
            topics: "/get-all-topics",
            channels: "/channels?topic=1"
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Xtream-Style API is running on port ${PORT}`);
});
