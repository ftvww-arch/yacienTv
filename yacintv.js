const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ==========================================
// 1. بروكسي الفيديو: لتخطي الحماية، حقن الهيدرز، وتجاهل SSL
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
                "User-Agent": customHeaders["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
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
        // لن نطبع الخطأ بالكامل حتى لا يمتلئ الكونسول، فقط رسالة بسيطة
        res.status(500).send("Proxy Error");
    }
});

// ==========================================
// 2. واجهة المشغل الذكي (البيانات مدمجة مباشرة بداخلها)
// ==========================================
app.get("/play", (req, res) => {
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>المشغل الذكي - نسخة تجريبية</title>
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
            <div id="title">جاري تهيئة البث التجريبي...</div>
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

            // البيانات التجريبية التي أرسلتها (مدمجة مباشرة)
            const rawApiData = [
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://dri.drivepointstorage.cyou/fif/three/index.html\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"Referer\\":\\"https://dri.drivepointstorage.cyou/\\"},\\"mediatype\\":\\"hls\\",\\"swap\\":{\\"k9x_\\":\\"\\"}}", "agent": "advanced", "name": "سيرفر 1" }, "name": "سيرفر 1" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://off.officefilesstoragehub.sbs/fif/one/index.html\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"Referer\\":\\"https://off.officefilesstoragehub.sbs/\\"},\\"mediatype\\":\\"hls\\",\\"swap\\":{\\"k9x_\\":\\"\\"}}", "agent": "advanced", "name": "سيرفر 2" }, "name": "سيرفر 2" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://dat2.datadenhosting.cyou/pages/ykyokykpcznq/index.html\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36\\",\\"Referer\\":\\"https://dat2.datadenhosting.cyou/\\"},\\"mediatype\\":\\"hls\\",\\"swap\\":{\\"k9x_\\":\\"\\"}}", "agent": "advanced", "name": "سيرفر 3" }, "name": "سيرفر 3" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 4" }, "name": "سيرفر 4" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 5" }, "name": "سيرفر 5" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 6" }, "name": "سيرفر 6" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 7" }, "name": "سيرفر 7" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 8" }, "name": "سيرفر 8" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 9" }, "name": "سيرفر 9" },
              { "result": 0, "data": { "url": "{\\"url\\":\\"https://163r39b4prtu.s3.us-east-1.amazonaws.com/hls/0/stream.m3u8\\",\\"agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"acceptSSL\\":\\"1\\",\\"headers\\":{\\"Referer\\":\\"https://gabito.store/1.php\\",\\"User-Agent\\":\\"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36\\",\\"Origin\\":\\"https://gabito.store\\"}}", "agent": "advanced", "name": "سيرفر 10" }, "name": "سيرفر 10" },
              { "result": 0, "data": { "url": "https://pub-10973a05d0414dd1b9f3595532f107b4.r2.dev/hls/0/stream.m3u8", "agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36", "name": "سيرفر 11" }, "name": "سيرفر 11" },
              { "result": 0, "data": { "url": "https://pub-10973a05d0414dd1b9f3595532f107b4.r2.dev/hls/0/stream.m3u8", "agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36", "name": "سيرفر 12" }, "name": "سيرفر 12" }
            ];

            // نظام اعتراض الطلبات (Loader)
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

            // فك التشفير وتهيئة السيرفرات (بدون API خارجي)
            function initTestData() {
                streamsData = [];

                rawApiData.forEach((item, index) => {
                    let streamObj = { name: item.name || \`سيرفر \${index + 1}\` };
                    let rawUrl = item.data?.url || item.url;

                    if (rawUrl && typeof rawUrl === 'string' && rawUrl.trim().startsWith('{')) {
                        try {
                            let parsed = JSON.parse(rawUrl);
                            streamObj.url = parsed.url;
                            streamObj.headers = parsed.headers || {};
                            streamObj.swap = parsed.swap || {};
                            streamObj.acceptSSL = parsed.acceptSSL || "0";
                            
                            // أخذ User-Agent إذا كان موجوداً بالخارج ولم يكن بالداخل
                            let explicitAgent = parsed.agent || item.data?.agent;
                            if (explicitAgent && !streamObj.headers['User-Agent']) {
                                streamObj.headers['User-Agent'] = explicitAgent;
                            }
                        } catch (e) { 
                            console.error("خطأ في فك تشفير JSON للسيرفر", index + 1, e); 
                        }
                    } else if (rawUrl) {
                        // للسيرفرات المباشرة مثل 11 و 12
                        streamObj.url = rawUrl;
                        streamObj.headers = {};
                        if (item.data?.agent) {
                            streamObj.headers['User-Agent'] = item.data.agent;
                        }
                    }
                    
                    if (streamObj.url) streamsData.push(streamObj);
                });

                if (streamsData.length === 0) {
                    titleElement.innerText = "لا توجد سيرفرات متاحة";
                    return;
                }

                populateServerList();
                playStream(0); // تشغيل السيرفر الأول تلقائياً
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
                        fLoader: ProxyLoader,
                        debug: false
                    });
                    hls.loadSource(videoUrl);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
                    
                    hls.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            console.warn("خطأ قاطع في التشغيل، جاري التبديل...");
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

            // تشغيل سكربت التهيئة فوراً
            initTestData();
        </script>
    </body>
    </html>
    `;
    
    res.send(htmlContent);
});

app.listen(PORT, () => {
    console.log("🚀 Standalone Test Server is running!");
    console.log(`👉 Open in browser: http://localhost:${PORT}/play`);
});
