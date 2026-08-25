const express = require('express');
const app = express();

app.set('json spaces', 2);

// القالب الثابت الذي سيتم إرجاعه في كل الحالات
const DEFAULT_RESPONSE = [{
    "id": "",
    "title": "",
    "img": "",
    "quality_144P": "",
    "quality_360P": "",
    "quality_720P": "",
    "quality_1080P": "",
    "quality_MP3": ""
}];

// دالة ذكية لفحص الرابط (تعيد الرابط إذا كان يعمل، أو "" إذا كان معطلاً)
async function checkUrlIsAlive(url) {
    if (!url) return "";
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 ثوانٍ كحد أقصى

        const response = await fetch(url, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 404 || response.status === 410 || response.status === 400) {
            return ""; 
        }
        return url; 
    } catch (error) {
        return "";
    }
}

// دالة للبحث واستخراج البيانات وترتيبها في الهيكل المطلوب
function parseAndFormatData(data) {
    let result = {
        id: "",
        title: "",
        img: "",
        quality_144P: "",
        quality_360P: "",
        quality_720P: "",
        quality_1080P: "",
        quality_MP3: ""
    };

    let mp3Links = [];

    function search(obj) {
        if (Array.isArray(obj)) {
            obj.forEach(item => search(item));
        } else if (obj !== null && typeof obj === 'object') {
            
            // استخراج البيانات الأساسية
            if (!result.id && obj.id) result.id = String(obj.id);
            if (!result.title && obj.title) result.title = String(obj.title);
            if (!result.img && (obj.thumbnail || obj.picture || obj.thumb || obj.image)) {
                result.img = String(obj.thumbnail || obj.picture || obj.thumb || obj.image);
            }

            // استخراج وتصنيف الروابط
            if (obj.download_url && obj.download_url.trim() !== "") {
                let format = (obj.format || "").toUpperCase();
                let quality = (obj.quality || "").toUpperCase();
                let url = obj.download_url;

                if (format.includes("MP3") || format.includes("AUDIO")) {
                    mp3Links.push({ url, quality });
                } else {
                    // توزيع جودات الفيديو
                    if (quality.includes("144") && !result.quality_144P) result.quality_144P = url;
                    if (quality.includes("360") && !result.quality_360P) result.quality_360P = url;
                    if (quality.includes("720") && !result.quality_720P) result.quality_720P = url;
                    if (quality.includes("1080") && !result.quality_1080P) result.quality_1080P = url;
                }
            }

            Object.values(obj).forEach(val => search(val));
        }
    }

    search(data);

    // اختيار **أقل** جودة MP3 متوفرة لتوفير استهلاك البيانات
    if (mp3Links.length > 0) {
        mp3Links.sort((a, b) => {
            let qa = parseInt(a.quality.replace(/\D/g, '')) || 0;
            let qb = parseInt(b.quality.replace(/\D/g, '')) || 0;
            // ترتيب تصاعدي: الأقل جودة سيكون في البداية (index 0)
            return qa - qb; 
        });
        result.quality_MP3 = mp3Links[0].url;
    }

    return result;
}





app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    
    if (!query) {
        return res.json({ error: "الرجاء إدخال كلمة البحث" });
    }

    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
            }
        });
        
        const html = await response.text();
        const match = html.match(/var ytInitialData = (.*?);<\/script>/);
        
        if (!match || !match[1]) return res.json([]);

        const jsonData = JSON.parse(match[1]);
        let results = [];

        // دالة تكرارية للبحث في كل أعماق البيانات لجلب كل الفيديوهات
        function extractVideos(obj) {
            if (Array.isArray(obj)) {
                obj.forEach(extractVideos);
            } else if (obj !== null && typeof obj === 'object') {
                if (obj.videoRenderer && obj.videoRenderer.videoId) {
                    const video = obj.videoRenderer;
                    results.push({
                        id: video.videoId || "",
                        title: video.title?.runs?.[0]?.text || "",
                        video_url: `https://www.youtube.com/watch?v=${video.videoId}`,
                        thumbnail: video.thumbnail?.thumbnails?.[0]?.url || "",
                        views: video.viewCountText?.simpleText || video.shortViewCountText?.simpleText || "",
                        published_at: video.publishedTimeText?.simpleText || "",
                        // الهيكل المسطح الجديد
                        channel_name: video.ownerText?.runs?.[0]?.text || "",
                        channel_url: video.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url 
                                     ? `https://www.youtube.com${video.ownerText.runs[0].navigationEndpoint.commandMetadata.webCommandMetadata.url}` 
                                     : "",
                        channel_avatar: video.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url || ""
                    });
                }
                Object.values(obj).forEach(extractVideos);
            }
        }

        extractVideos(jsonData.contents || {});

        // تنظيف الفيديوهات المكررة (لأن يوتيوب أحياناً يكرر الفيديو في المقترحات)
        const uniqueResults = Array.from(new Map(results.map(item => [item.id, item])).values());

        res.json(uniqueResults);

    } catch (error) {
        console.error("Search Error:", error);
        res.json([]);
    }
});









// ============ مسار استخراج فيديوهات القناة فقط ============
app.get('/api/channel/videos', async (req, res) => {
    const channelUrl = req.query.url;
    
    if (!channelUrl) {
        return res.json({ 
            error: "الرجاء إدخال رابط القناة",
            example: "/api/channel/videos?url=https://www.youtube.com/@IShowSpeed/videos"
        });
    }

    try {
        const response = await fetch(channelUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        const html = await response.text();
        let videos = [];
        let videosMap = new Map();

        // الطريقة 1: استخراج من ytInitialData
        const match = html.match(/var ytInitialData = (.*?);<\/script>/);
        if (match && match[1]) {
            try {
                const jsonData = JSON.parse(match[1]);
                const jsonStr = JSON.stringify(jsonData);
                
                // البحث عن كل عناصر الفيديو في النص
                const videoPattern = /\{"videoRenderer":\{.*?\}\}(?=\}|\])/g;
                const videoMatches = jsonStr.match(videoPattern);
                
                if (videoMatches) {
                    videoMatches.forEach(videoStr => {
                        try {
                            // استخراج videoId
                            const idMatch = videoStr.match(/"videoId":"([^"]+)"/);
                            if (!idMatch) return;
                            const videoId = idMatch[1];
                            
                            // استخراج العنوان
                            let title = "";
                            const titleMatch = videoStr.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
                            if (titleMatch) {
                                title = titleMatch[1];
                            }
                            
                            // إذا لم نجد العنوان، نبحث عن simpleText
                            if (!title) {
                                const simpleTitleMatch = videoStr.match(/"title":\{"simpleText":"([^"]+)"/);
                                if (simpleTitleMatch) {
                                    title = simpleTitleMatch[1];
                                }
                            }
                            
                            // استخراج الصورة المصغرة
                            let thumbnail = "";
                            const thumbMatch = videoStr.match(/"url":"(https:\/\/i\.ytimg\.com\/vi\/[^"]+)"/);
                            if (thumbMatch) {
                                thumbnail = thumbMatch[1];
                            }
                            
                            // استخراج المشاهدات
                            let views = "";
                            const viewsMatch = videoStr.match(/"viewCountText":\{"simpleText":"([^"]+)"/);
                            if (viewsMatch) {
                                views = viewsMatch[1];
                            } else {
                                const shortViewsMatch = videoStr.match(/"shortViewCountText":\{"simpleText":"([^"]+)"/);
                                if (shortViewsMatch) {
                                    views = shortViewsMatch[1];
                                }
                            }
                            
                            // استخراج تاريخ النشر
                            let publishedAt = "";
                            const publishedMatch = videoStr.match(/"publishedTimeText":\{"simpleText":"([^"]+)"/);
                            if (publishedMatch) {
                                publishedAt = publishedMatch[1];
                            }
                            
                            // استخراج المدة
                            let duration = "";
                            const durationMatch = videoStr.match(/"lengthText":\{"simpleText":"([^"]+)"/);
                            if (durationMatch) {
                                duration = durationMatch[1];
                            }
                            
                            // إضافة الفيديو إذا كان له معرف صحيح
                            if (videoId && videoId.length === 11 && !videosMap.has(videoId)) {
                                videosMap.set(videoId, {
                                    id: videoId,
                                    title: title || "",
                                    video_url: `https://www.youtube.com/watch?v=${videoId}`,
                                    thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                                    views: views || "",
                                    published_at: publishedAt || "",
                                    duration: duration || ""
                                });
                            }
                        } catch (e) {
                            // تجاهل الأخطاء
                        }
                    });
                }
            } catch (error) {
                console.error("Error parsing ytInitialData:", error);
            }
        }

        // الطريقة 2: استخراج من ytInitialData باستخدام regex مختلف
        if (videosMap.size === 0) {
            const match2 = html.match(/var ytInitialData = (.*?);<\/script>/);
            if (match2 && match2[1]) {
                try {
                    const jsonData = JSON.parse(match2[1]);
                    
                    // البحث عن كل videoId في البيانات
                    function extractAllVideos(obj, depth = 0) {
                        if (depth > 30) return;
                        
                        if (Array.isArray(obj)) {
                            obj.forEach(item => extractAllVideos(item, depth + 1));
                        } else if (obj !== null && typeof obj === 'object') {
                            
                            // البحث عن videoId
                            if (obj.videoId && typeof obj.videoId === 'string' && obj.videoId.length === 11) {
                                const videoId = obj.videoId;
                                
                                // محاولة استخراج العنوان من الكائن الحالي
                                let title = "";
                                let thumbnail = "";
                                let views = "";
                                let publishedAt = "";
                                let duration = "";
                                
                                // البحث في الكائن الحالي
                                if (obj.title) {
                                    if (typeof obj.title === 'string') {
                                        title = obj.title;
                                    } else if (obj.title.runs && Array.isArray(obj.title.runs)) {
                                        title = obj.title.runs.map(r => r.text || "").join("");
                                    } else if (obj.title.simpleText) {
                                        title = obj.title.simpleText;
                                    } else if (obj.title.content) {
                                        title = obj.title.content;
                                    }
                                }
                                
                                if (obj.thumbnail?.thumbnails) {
                                    thumbnail = obj.thumbnail.thumbnails[obj.thumbnail.thumbnails.length - 1]?.url || "";
                                }
                                
                                if (obj.viewCountText?.simpleText) {
                                    views = obj.viewCountText.simpleText;
                                } else if (obj.viewCountText?.content) {
                                    views = obj.viewCountText.content;
                                }
                                
                                if (obj.publishedTimeText?.simpleText) {
                                    publishedAt = obj.publishedTimeText.simpleText;
                                }
                                
                                if (obj.lengthText?.simpleText) {
                                    duration = obj.lengthText.simpleText;
                                }
                                
                                // إضافة الفيديو
                                if (!videosMap.has(videoId)) {
                                    videosMap.set(videoId, {
                                        id: videoId,
                                        title: title || "",
                                        video_url: `https://www.youtube.com/watch?v=${videoId}`,
                                        thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                                        views: views || "",
                                        published_at: publishedAt || "",
                                        duration: duration || ""
                                    });
                                }
                            }
                            
                            // البحث في العناصر الفرعية
                            Object.values(obj).forEach(value => extractAllVideos(value, depth + 1));
                        }
                    }
                    
                    extractAllVideos(jsonData);
                    
                } catch (error) {
                    console.error("Error in extractAllVideos:", error);
                }
            }
        }

        // الطريقة 3: استخراج من HTML مباشرة
        if (videosMap.size === 0) {
            // استخراج كل روابط الفيديو من HTML
            const videoLinks = html.match(/href="\/watch\?v=([a-zA-Z0-9_-]{11})"/g);
            
            if (videoLinks) {
                const uniqueIds = [...new Set(videoLinks.map(link => {
                    const match = link.match(/v=([a-zA-Z0-9_-]{11})/);
                    return match ? match[1] : null;
                }).filter(Boolean))];
                
                uniqueIds.slice(0, 30).forEach(videoId => {
                    // محاولة استخراج العنوان من الصورة المصغرة
                    const imgMatch = html.match(new RegExp(`<img[^>]*src="https://i\\.ytimg\\.com/vi/${videoId}/[^"]*"[^>]*alt="([^"]*)"`));
                    const title = imgMatch ? imgMatch[1] : "";
                    
                    if (!videosMap.has(videoId)) {
                        videosMap.set(videoId, {
                            id: videoId,
                            title: title,
                            video_url: `https://www.youtube.com/watch?v=${videoId}`,
                            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                            views: "",
                            published_at: "",
                            duration: ""
                        });
                    }
                });
            }
        }

        // تحويل Map إلى Array
        videos = Array.from(videosMap.values());
        
        // إزالة الفيديوهات بدون عنوان (إذا كان هناك فيديوهات بعناوين)
        const videosWithTitles = videos.filter(v => v.title && v.title !== "");
        if (videosWithTitles.length > 0) {
            videos = videosWithTitles;
        }
        
        // إزالة الفيديوهات المكررة والاحتفاظ بأول 30
        const uniqueVideos = Array.from(new Map(videos.map(video => [video.id, video])).values());
        const recentVideos = uniqueVideos.slice(0, 30);
        
        // إرجاع المصفوفة مباشرة
        res.json(recentVideos);

    } catch (error) {
        console.error("Channel Videos Error:", error);
        res.status(500).json({ 
            error: "حدث خطأ أثناء استخراج فيديوهات القناة",
            details: error.message 
        });
    }
});















// إعداد مسار الـ API
app.get('/api/extract', async (req, res) => {
    const videoUrl = req.query.url; 
    
    if (!videoUrl) {
        return res.json(DEFAULT_RESPONSE); 
    }

    const apiUrl = "https://api.vidssave.com/api/contentsite_api/media/parse";
    const formData = new URLSearchParams();
    
    formData.append("link", videoUrl); 
    formData.append("auth", "20250901majwlqo"); 
    formData.append("domain", "api-ak.vidssave.com");
    formData.append("origin", "source");

    try {
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://ar.vidssave.com",
                "Referer": "https://ar.vidssave.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            body: formData
        });
        
        const rawData = await response.json();
        
        // ترتيب البيانات في الهيكل الثابت
        let formattedData = parseAndFormatData(rawData);
        
        // فحص الروابط بالتوازي للتأكد من أنها تعمل
        const finalResult = {
            id: formattedData.id,
            title: formattedData.title,
            img: formattedData.img,
            quality_144P: await checkUrlIsAlive(formattedData.quality_144P),
            quality_360P: await checkUrlIsAlive(formattedData.quality_360P),
            quality_720P: await checkUrlIsAlive(formattedData.quality_720P),
            quality_1080P: await checkUrlIsAlive(formattedData.quality_1080P),
            quality_MP3: await checkUrlIsAlive(formattedData.quality_MP3)
        };
        
        // إرجاع النتيجة
        res.json([finalResult]); 

    } catch (error) {
        console.error("Fetch Error:", error);
        res.json(DEFAULT_RESPONSE);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
