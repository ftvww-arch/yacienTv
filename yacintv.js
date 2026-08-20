const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/play/:channel', async (req, res) => {
    try {
        // 1. جلب البيانات من الـ API الأساسي بناءً على اسم القناة
        const channelName = req.params.channel;
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/last/live_tv_${channelName}`);
        
        // استخراج البيانات حسب الهيكل المرسل
        const responseData = apiResponse.data;
        
        if (responseData.result !== 0) {
            return res.status(400).send('فشل في جلب بيانات القناة');
        }

        // 2. فك الـ JSON الداخلي الموجود داخل data.url
        const innerData = JSON.parse(responseData.data.url);
        const streamUrl = innerData.url;
        const headers = innerData.headers;

        // 3. عرض صفحة HTML تحتوي على مشغل الفيديو
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>مشغل البث المباشر</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    body { background: #000; color: #fff; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
                    video { width: 100%; max-height: 100vh; }
                </style>
            </head>
            <body>
                <video id="videoPlayer" controls autoplay></video>
                <script>
                    var video = document.getElementById('videoPlayer');
                    var videoSrc = "${streamUrl}";
                    
                    if (Hls.isSupported()) {
                        var hls = new Hls();
                        hls.loadSource(videoSrc);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, function() {
                            video.play();
                        });
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = videoSrc;
                        video.addEventListener('loadedmetadata', function() {
                            video.play();
                        });
                    }
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
