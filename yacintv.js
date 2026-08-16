const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ==========================================
// 1. بروكسي الـ API: لجلب بيانات السيرفرات بدون مشاكل CORS
// ==========================================
app.get("/api/stream", async (req, res) => {
    try {
        const id_live = req.query.id_live;
        if (!id_live) return res.status(400).json({ error: "id_live is required" });

        // نطلب البيانات من الـ API الأصلي عبر السيرفر (Node.js لا يتأثر بـ CORS)
        const response = await axios.get(`https://yacintv-api.onrender.com/stream?id_live=${id_live}`);
        
        // نرسل البيانات كـ JSON للمتصفح
        res.json(response.data);
    } catch (error) {
        console.error("API Fetch Error:", error.message);
        res.status(500).json({ error: "فشل الاتصال بالخادم الخارجي للـ API" });
    }
});

// ==========================================
// 2. بروكسي الفيديو: القلب النابض الذي يحقن الهيدرز ويتخطى SSL
// ==========================================
app.get("/proxy", async (req, res) => {
    try {
        const targetUrl = req.query.url;
        const headersStr = req.query.headers || "{}";
        const acceptSSL = req.query.acceptSSL || "0";
        
        if (!targetUrl) return res.status(400).send("URL is required");

        const customHeaders = JSON.parse(decodeURIComponent(headersStr));

        const axiosConfig = {
            method: "GET",
            url: targetUrl,
            headers: {
                "User-Agent": customHeaders["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": customHeaders["Referer"] || "",
                ...customHeaders
            },
            responseType: "stream",
            httpsAgent: new https.Agent({ rejectUnauthorized: acceptSSL !== "1" })
        };

        const response = await axios(axiosConfig);
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Content-Type", response.headers["content-type"] || "application/vnd.apple.mpegurl");
        
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send("Proxy Error");
    }
});

// ==========================================
// 3. واجهة المشغل الذكي (HTML + JS + CSS)
// ==========================================
app.get("/play", (req, res) => {
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>المشغل الذكي</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <style>
            body {
                background-color: #0b1a2a; 
                color: #ffffff;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                padding: 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
                min-height: 100vh;
            }
            .player-container {
                width: 100%;
                max-width: 900px;
                background-color: #12253a;
                border-radius: 12px;
                padding: 20px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                border: 2px solid #ffcc00; 
            }
            #title {
                font-size: 22px;
                font-weight: bold;
                margin-bottom: 15px;
                color: #ffcc00;
                text-align: center;
            }
            video {
                width: 100%;
                border-radius: 8px;
                background: #000;
                outline: none;
                aspect-ratio: 16/9;
            }
            .controls {
                display: flex;
                justify-content: center;
                gap: 15px;
                margin-top: 20px;
            }
            select {
                padding: 12px 20px;
                font-size: 16px;
                border-radius: 6px;
                border: 1px solid #ffcc00;
                background-color: #0b1a2a;
                color: #ffcc00;
                cursor: pointer;
                font-weight: bold;
                outline: none;
            }
            select:focus { box-shadow: 0 0 8px rgba(255, 204, 0, 0.6); }
        </style>
    </head>
    <body>

        <div class="player-container">
            <div id="title">جاري استخراج البث...</div>
            <video id="videoPlayer" controls autoplay playsinline></video>
            
            <div class="controls">
                <select id="serverSelect" onchange="changeServer()"></select>
            </div>
        </div>

        <script>
            const video = document.getElementById('videoPlayer');
            const serverSelect = document.getElementById('serverSelect');
            const titleElement = document.getElementById('title');
            let hls;
            let streamsData = [];
            let currentStreamConfig = null;

            const urlParams = new URLSearchParams(window.location.search);
            const channelId = urlParams.get('id_live') || 'live_tv_beinsport1';

            // نظام اعتراض الطلبات (Loader) لتطبيق الـ Swap والبروكسي
            class ProxyLoader extends Hls.DefaultConfig.loader {
                constructor(config) { super(config); }
                load(context, config, callbacks) {
                    let targetUrl = context.url;
                    
                    if (currentStreamConfig && currentStreamConfig.swap) {
                        for (let key in currentStreamConfig.swap) {
                            if (targetUrl.includes(key)) {
                                targetUrl = targetUrl.replace(key, currentStreamConfig.swap[key]);
                            }
                        }
                    }

                    if (currentStreamConfig) {
                        const headersStr = encodeURIComponent(JSON.stringify(currentStreamConfig.headers || {}));
                        context.url = \`/proxy?url=\${encodeURIComponent(targetUrl)}&headers=\${headersStr}&acceptSSL=\${currentStreamConfig.acceptSSL}\`;
                    }

                    super.load(context, config, callbacks);
                }
            }

            // استخراج وتفكيك بيانات API عبر السيرفر الداخلي
            async function fetchStreamData() {
                try {
                    // التغيير هنا: نطلب من الخادم المحلي بدلاً من الخارجي مباشرة
                    const response = await fetch(\`/api/stream?id_live=\${channelId}\`);
                    
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }

                    const data = await response.json();
                    streamsData = [];

                    // التأكد من أن البيانات مصفوفة
                    if (!Array.isArray(data)) {
                        throw new Error('API لم يرجع مصفوفة بيانات صحيحة');
                    }

                    data.forEach((item, index) => {
                        let streamObj = { name: item.name || \`سيرفر \${index + 1}\` };
                        let rawUrl = item.data?.url || item.url;

                        if (rawUrl && rawUrl.trim().startsWith('{')) {
                            try {
                                let parsed = JSON.parse(rawUrl);
                                streamObj.url = parsed.url;
                                streamObj.headers = parsed.headers || {};
                                streamObj.swap = parsed.swap || {};
                                streamObj.acceptSSL = parsed.acceptSSL || "0";
                                if (parsed.agent && !streamObj.headers['User-Agent']) {
                                    streamObj.headers['User-Agent'] = parsed.agent;
                                }
                            } catch (e) { console.error("خطأ في فك تشفير JSON:", e); }
                        } else if (rawUrl) {
                            streamObj.url = rawUrl;
                            streamObj.headers = {};
                        }
                        
                        if (streamObj.url) streamsData.push(streamObj);
                    });

                    if (streamsData.length === 0) {
                        titleElement.innerText = "لا توجد سيرفرات متاحة";
                        return;
                    }

                    populateServerList();
                    playStream(0);

                } catch (error) {
                    console.error("مشكلة مفصلة:", error);
                    titleElement.innerText = "فشل جلب أو فك تشفير البث (راجع الـ Console)";
                }
            }

            function populateServerList() {
                serverSelect.innerHTML = '';
                streamsData.forEach((stream, index) => {
                    let option = document.createElement('option');
                    option.value = index;
                    option.innerText = stream.name;
                    serverSelect.appendChild(option);
                });
            }

            function changeServer() {
                playStream(serverSelect.value);
            }

            function playStream(index) {
                if (hls) hls.destroy();

                currentStreamConfig = streamsData[index];
                titleElement.innerText = currentStreamConfig.name;
                const videoUrl = currentStreamConfig.url;

                if (Hls.isSupported()) {
                    hls = new Hls({
                        pLoader: ProxyLoader,
                        fLoader: ProxyLoader
                    });
                    hls.loadSource(videoUrl);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
                    
                    hls.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            let nextIndex = parseInt(index) + 1;
                            if (nextIndex < streamsData.length) {
                                serverSelect.value = nextIndex;
                                playStream(nextIndex);
                            } else {
                                titleElement.innerText = "فشلت جميع السيرفرات";
                            }
                        }
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    const headersStr = encodeURIComponent(JSON.stringify(currentStreamConfig.headers || {}));
                    video.src = \`/proxy?url=\${encodeURIComponent(videoUrl)}&headers=\${headersStr}&acceptSSL=\${currentStreamConfig.acceptSSL}\`;
                    video.play();
                }
            }

            fetchStreamData();
        </script>
    </body>
    </html>
    `;
    
    res.send(htmlContent);
});

app.listen(PORT, () => {
    console.log("🚀 Server is running!");
    console.log(`👉 Open in browser: http://localhost:${PORT}/play?id_live=live_tv_beinsport1`);
});
