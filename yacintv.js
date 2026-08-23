const express = require('express');
const axios = require('axios');
const app = express();

app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. الإعدادات العامة (Configuration)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://sunny-appreciation-production-3d25.up.railway.app/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
};

// خريطة لتخزين أرقام القنوات (Xtream يتطلب أرقام IDs صحيحة وليس نصوص)
const streamMap = new Map();

process.on('uncaughtException', (err) => console.error('Caught exception: ', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ==========================================
// 2. التخزين المؤقت (Cache Engine) - تم الإبقاء عليه لسرعته الممتازة
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),
    async getOrFetch(key, fetcher, ttl) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        if (this.inFlight.has(key)) return new Promise((resolve, reject) => { this.inFlight.get(key).push({ resolve, reject }); });
        
        this.inFlight.set(key, []);
        try {
            const data = await fetcher();
            if (this.memory.size > 300) this.memory.delete(this.memory.keys().next().value);
            this.memory.set(key, { data, expiresAt: Date.now() + ttl });
            
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(w => w.resolve(data));
            return data;
        } catch (error) {
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(w => w.reject(error));
            throw error;
        }
    }
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 60000);

// ==========================================
// 3. جلب الروابط وتجهيزها
// ==========================================
async function fetchChannelServers(realChannelName) {
    const channelId = `live_tv_${realChannelName}`;
    let dataArray = null;

    try {
        const response1 = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: channelId }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (response1.data && (!Array.isArray(response1.data) || response1.data.length > 0)) dataArray = Array.isArray(response1.data) ? response1.data : [response1.data];
    } catch (e) {}

    if (!dataArray || dataArray.length === 0) {
        try {
            const response2 = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            if (response2.data) dataArray = Array.isArray(response2.data) ? response2.data : [response2.data];
        } catch (e) {}
    }

    if (!dataArray || dataArray.length === 0) throw new Error('لا توجد بيانات');

    const servers = [];
    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = srv.data.url;
            let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() };
            servers.push({ name: srv.name || `جودة ${i + 1}`, url: innerData.url, headers: innerData.headers || {}, swap: innerData.swap || null });
        } catch (e) {}
    });
    if (servers.length === 0) throw new Error('لا توجد سيرفرات');
    return servers;
}

// تعديل الروابط لتصبح مباشرة إلى السيرفر الأصلي (يمنع استهلاك الباندويث من سيرفرك)
async function fetchManifest(serverInfo) {
    const headers = { 'User-Agent': serverInfo.headers['User-Agent'] || 'Mozilla/5.0' };
    if (serverInfo.headers['Referer']) headers['Referer'] = serverInfo.headers['Referer'];
    
    const response = await axios.get(serverInfo.url, { headers, timeout: 10000 });
    let m3u8 = response.data;
    const baseUrl = serverInfo.url.substring(0, serverInfo.url.lastIndexOf('/') + 1);
    const swapKey = serverInfo.swap ? Object.keys(serverInfo.swap)[0] : null;
    const swapVal = swapKey ? serverInfo.swap[swapKey] : null;

    return m3u8.replace(/^(?!#)(.*)$/gm, (line) => {
        let url = line.trim();
        if (!url || url.startsWith('#')) return line;
        if (!url.startsWith('http')) url = baseUrl + url; // هذا السطر يجعل التطبيق يسحب الفيديو من المصدر مباشرة وليس من سيرفرك
        if (swapKey && url.includes(swapKey)) url = url.replace(swapKey, swapVal);
        return url;
    });
}

// توليد رقم فريد لكل قناة ليفهمه تطبيق Xtream
function generateStreamId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}


// ==========================================
// 4. مسارات Xtream Codes API (التي يقرأها Ibo Player)
// ==========================================
app.get('/player_api.php', async (req, res) => {
    const { username, password, action } = req.query;
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. تسجيل الدخول
    if (!action) {
        return res.json({
            user_info: {
                username: username || "free",
                password: password || "free",
                auth: 1, 
                status: "Active",
                exp_date: "1999999999", 
                max_connections: "99"
            },
            server_info: {
                url: req.hostname,
                port: "80",
                https_port: "443",
                server_protocol: "http",
                timezone: "Asia/Amman"
            }
        });
    }

    // 2. إرسال أقسام البث المباشر
    if (action === 'get_live_categories') {
        return res.json([{ category_id: "1", category_name: "⚽ مباريات اليوم والمباشر", parent_id: 0 }]);
    }

    // 3. إرسال قنوات البث المباشر
    if (action === 'get_live_streams') {
        try {
            const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                const response = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 8000 }); // رفعنا وقت الانتظار لـ 8 ثواني لتفادي بطء المصدر
                return response.data;
            }, 60000);

            const streams = [];
            matches.forEach(match => {
                let channelStr = match.channel || match.id_live || '';
                let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                
                if (!cleanChannel) return;

                const streamId = generateStreamId(cleanChannel);
                streamMap.set(streamId, cleanChannel);

                let matchTitle = match.title || match.name || match.match_name;
                if (!matchTitle && match.team1 && match.team2) matchTitle = `${match.team1} vs ${match.team2}`;

                streams.push({
                    num: streamId,
                    name: matchTitle || cleanChannel,
                    stream_type: "live",
                    stream_id: streamId,
                    stream_icon: match.logo || "https://i.imgur.com/rXo2o7u.png",
                    epg_channel_id: "",
                    added: "1700000000",
                    category_id: "1",
                    custom_sid: "",
                    tv_archive: 0,
                    direct_source: ""
                });
            });

            return res.json(streams);
        } catch (error) {
            console.error("Error fetching streams:", error.message);
            return res.json([]); 
        }
    }

    // 4. (الحل السحري) الرد على التطبيق بخصوص الأفلام والمسلسلات حتى لا يعطي خطأ
    if (action === 'get_vod_categories' || action === 'get_series_categories' || action === 'get_vod_streams' || action === 'get_series') {
        return res.json([]); // إرسال قائمة فارغة تخبر التطبيق أنه لا يوجد أفلام
    }

    // الرد الافتراضي لأي طلب غير معروف
    return res.json([]);
});

// ==========================================
// 5. مسار تشغيل البث المباشر الفعلي (Live Stream Router)
// ==========================================
app.get('/live/:username/:password/:streamFile', async (req, res) => {
    try {
        // يتم استخراج رقم الـ ID من اسم الملف، مثلا 101.m3u8 يصبح 101
        const streamFile = req.params.streamFile;
        const streamId = parseInt(streamFile.split('.')[0]);

        // البحث عن اسم القناة الحقيقي المخزن في الذاكرة
        const realChannel = streamMap.get(streamId);
        if (!realChannel) return res.status(404).send('القناة غير موجودة');

        // جلب سيرفرات القناة
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        if (!servers || servers.length === 0) return res.status(404).send('لا يوجد بث متاح حالياً');

        // استخدام الجودة الأولى كافتراضي
        const serverInfo = servers[0];

        // جلب الـ Manifest ومعالجته
        const manifestData = await CacheEngine.getOrFetch(`manifest_${realChannel}_0`, () => fetchManifest(serverInfo), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(manifestData);

    } catch (error) {
        res.status(500).send('حدث خطأ أثناء تشغيل البث');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Xtream API Server is running on port ${PORT}`);
});
