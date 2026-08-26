const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------
// إعدادات الذاكرة المؤقتة (لتسريع الاستجابة للحد الأقصى)
// ---------------------------------------------------------
const pageCache = new Map(); // كاش للصفحات والبيانات
const imageCache = new Map(); // كاش لروابط الصور فقط
const CACHE_TTL = 10 * 60 * 1000; // مدة الكاش: 5 دقائق (يمكنك تعديلها)

// دالة مساعدة لجلب البيانات من الكاش إن وجدت وكانت صالحة
function getCachedData(key) {
    const cached = pageCache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }
    return null;
}

// دالة مساعدة لحفظ البيانات في الكاش
function setCachedData(key, data) {
    pageCache.set(key, { data, timestamp: Date.now() });
}

// ---------------------------------------------------------
// الهيكل الثابت الموحد لجميع المسارات 
// ---------------------------------------------------------
const emptyResponse = {
    id: "", title: "", url: "", image: "", genres: "", quality: "", imdb: "", eclip_Num: ""
};

// دالة مساعدة لتعديل الروابط
function formatUrl(url, baseUrl) {
    if (!url) return "";
    let fullUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
    return fullUrl.replace('/video.php?vid=', '/play.php?vid=');
}

// ---------------------------------------------------------
// المسار الأول: استخراج الأفلام والمسلسلات (بأقصى سرعة + Cache)
// ---------------------------------------------------------
app.get('/api/page', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    // 1. التحقق من الكاش أولاً (استجابة فورية)
    const cacheKey = req.originalUrl;
    const cachedResponse = getCachedData(cacheKey);
    if (cachedResponse) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(cachedResponse);
    }

    try {
        // 2. طلب الصفحة بمهلة أقصاها 5 ثوانٍ لتجنب تعليق السيرفر
        const response = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) return res.json([emptyResponse]);

        const html = await response.text();
        const $ = cheerio.load(html);
        const baseUrl = new URL(targetUrl).origin;
        const host = req.protocol + '://' + req.get('host');
        const finalMoviesList = [];

        // 3. استخراج البيانات المباشرة بدون انتظار الصور
        $('li.col-xs-6.col-sm-4.col-md-3').each((index, element) => {
            if (index >= 30) return false; 

            const box = $(element);
            const rawUrl = box.find('a').first().attr('href') || "";
            if (!rawUrl) return true;

            const fetchUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, baseUrl).href;
            const movieUrl = formatUrl(rawUrl, baseUrl);
            const title = box.find('.caption h3 a').text().trim() || box.find('a').first().attr('title') || "";
            const quality = box.find('.pm-video-labels .hot').text().trim() || "";
            const eclip_Num = box.find('.pm-label-duration').text().trim() || "";
            const id = movieUrl ? crypto.createHash('md5').update(movieUrl).digest('hex') : "";

            finalMoviesList.push({
                id, 
                title, 
                url: movieUrl,
                // مسار الصور الديناميكي
                image: `${host}/floratv/api/image?url=${encodeURIComponent(fetchUrl)}&baseUrl=${encodeURIComponent(baseUrl)}`,
                quality, 
                eclip_Num,
                genres: "",
                imdb: ""
            });
        });

        if (finalMoviesList.length === 0) return res.json([emptyResponse]);

        // 4. حفظ النتيجة في الكاش وإرسالها
        setCachedData(cacheKey, finalMoviesList);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(finalMoviesList);

    } catch (error) {
        console.error("Error in /api/page:", error.message);
        res.json([emptyResponse]);
    }
});



// إضافة مسار الدومين الأساسي ليعرض مصفوفة فارغة
app.get('/', (req, res) => {
  res.json([]);
});



// ---------------------------------------------------------
// المسار المساعد: استخراج الصورة والتوجيه إليها (بدون كراش)
// ---------------------------------------------------------
app.get('/api/image', async (req, res) => {
    const targetUrl = req.query.url;
    const baseUrl = req.query.baseUrl;
    const fallbackImage = "https://via.placeholder.com/300x450?text=No+Image";

    if (!targetUrl) return res.redirect(fallbackImage);

    // التحقق من كاش الصور
    if (imageCache.has(targetUrl)) {
        return res.redirect(imageCache.get(targetUrl));
    }

    try {
        // مهلة 2.5 ثانية فقط للصورة حتى لا يتراكم الضغط على السيرفر
        const pageResponse = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(2500) 
        });
        
        const pageHtml = await pageResponse.text();
        const $$ = cheerio.load(pageHtml);
        
        let imageUrl = $$('link[rel="image_src"]').attr('href') || $$('meta[property="og:image"]').attr('content') || "";
        
        if (imageUrl && !imageUrl.startsWith('http')) {
            imageUrl = new URL(imageUrl, baseUrl).href;
        }

        if (imageUrl) {
            imageCache.set(targetUrl, imageUrl);
            return res.redirect(imageUrl);
        } else {
            return res.redirect(fallbackImage);
        }
    } catch (err) {
        // إذا تأخر الموقع أو حدث خطأ، اعرض الصورة الافتراضية بدلاً من انهيار التطبيق
        return res.redirect(fallbackImage);
    }
});

// ---------------------------------------------------------
// المسار الثاني: استخراج المواسم (+ Cache)
// ---------------------------------------------------------
app.get('/api/seasons', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    const cacheKey = req.originalUrl;
    const cachedResponse = getCachedData(cacheKey);
    if (cachedResponse) return res.json(cachedResponse);

    try {
        const response = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) return res.json([emptyResponse]);

        const html = await response.text();
        const $ = cheerio.load(html);
        const seasonsList = [];
        const metaImage = $('meta[property="og:image"]').attr('content') || "";

        $('div.SeasonsBoxUL ul li').each((index, element) => {
            const li = $(element);
            const seasonNumber = li.attr('data-serie') || "";
            const title = li.text().trim() || `الموسم ${seasonNumber}`;
            const seasonUrl = `${targetUrl}&season_id=${seasonNumber}`;
            const id = seasonUrl ? crypto.createHash('md5').update(seasonUrl).digest('hex') : "";

            seasonsList.push({
                id, title, url: seasonUrl, image: metaImage, genres: "", quality: "", imdb: "", eclip_Num: "" 
            });
        });

        if (seasonsList.length === 0) return res.json([emptyResponse]);

        setCachedData(cacheKey, seasonsList);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(seasonsList);

    } catch (error) {
        res.json([emptyResponse]);
    }
});

// ---------------------------------------------------------
// المسار الثالث: استخراج الحلقات (+ Cache)
// ---------------------------------------------------------
app.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    const cacheKey = req.originalUrl;
    const cachedResponse = getCachedData(cacheKey);
    if (cachedResponse) return res.json(cachedResponse);

    try {
        let seasonId = req.query.season_id || new URL(targetUrl).searchParams.get('season_id');

        const response = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) return res.json([emptyResponse]);

        const html = await response.text();
        const $ = cheerio.load(html);
        const baseUrl = new URL(targetUrl).origin;
        
        let imageUrl = $('link[rel="image_src"]').attr('href') || $('meta[property="og:image"]').attr('content') || "";
        if (imageUrl && !imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, baseUrl).href;

        const episodesList = [];
        let episodesContainer = seasonId ? $(`div.SeasonsEpisodes[data-serie="${seasonId}"]`) : $('div.SeasonsEpisodes').first();

        episodesContainer.find('a').each((i, el) => {
            const aTag = $(el);
            let rawUrl = aTag.attr('href') || "";
            if (!rawUrl) return true;

            let episodeUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, baseUrl).href;
            episodeUrl = episodeUrl.replace('/video.php?vid=', '/play.php?vid=');
            const title = aTag.attr('title') || aTag.text().trim() || "";
            const epNumText = aTag.find('em').text().trim();
            const eclip_Num = epNumText ? `الحلقة ${epNumText}` : "";
            const id = crypto.createHash('md5').update(episodeUrl).digest('hex');

            episodesList.push({ id, title, url: episodeUrl, image: imageUrl, genres: "", quality: "", imdb: "", eclip_Num });
        });

        if (episodesList.length === 0) return res.json([emptyResponse]);

        setCachedData(cacheKey, episodesList);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(episodesList);

    } catch (error) {
        res.json([emptyResponse]);
    }
});

// ---------------------------------------------------------
// المسار الرابع: استخراج السيرفرات (+ Cache)
// ---------------------------------------------------------
app.get('/api/watch', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    const cacheKey = req.originalUrl;
    const cachedResponse = getCachedData(cacheKey);
    if (cachedResponse) return res.json(cachedResponse);

    try {
        const response = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(5000)
        });

        const html = await response.text();
        const $ = cheerio.load(html);
        
        const validServers = [{ url: targetUrl }];
        const listItems = $('ul.WatchList li');
        const blockedDomains = ['llvpn', 'ads', 'pop', 'blank', 'd0o0d', 'updown.icu'];

        listItems.each((index, element) => {
            const li = $(element);
            const iframeSrc = li.attr('data-embed-url') || "";
            const isBlocked = blockedDomains.some(d => iframeSrc.includes(d));

            if (iframeSrc && iframeSrc.startsWith('http') && !isBlocked && iframeSrc !== targetUrl) {
                validServers.push({ url: iframeSrc });
            }
        });

        if (validServers.length === 1) {
            const directIframe = $('iframe').first().attr('src');
            if (directIframe && directIframe.startsWith('http') && directIframe !== targetUrl) {
                validServers.push({ url: directIframe });
            }
        }

        setCachedData(cacheKey, validServers);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(validServers);

    } catch (error) {
        console.error("Error in /api/watch:", error.message);
        return res.json([{ url: targetUrl }]); // إرجاع الرابط الأساسي لضمان عمل التطبيق
    }
});

module.exports = app;
