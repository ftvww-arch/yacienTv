const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------
// الهياكل الأساسية والـ Headers والتعابير المنتظمة (Regex)
// ---------------------------------------------------------
const emptyResponse = {
    title: "", link: "", image: "", quality: "", category: "", views: "", imdb: "", type: ""
};

const getHeaders = (targetUrl) => {
    try {
        const urlObj = new URL(targetUrl);
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
            "Connection": "keep-alive",
            "Referer": urlObj.origin + "/", 
            "Origin": urlObj.origin,
            "Referrer-Policy": "strict-origin-when-cross-origin"
        };
    } catch (e) {
        return {};
    }
};

const fetchHtmlContent = async (url) => {
    try {
        const response = await fetch(url, { headers: getHeaders(url) });
        if (!response.ok) return null;
        return await response.text();
    } catch (error) {
        return null;
    }
};

const pCleanup = /&#8211;|–|&#\d+;|&amp;/g;
const pHtmlEntity = /&[^\s;]+;/g;


// ---------------------------------------------------------
// 1. دوال استخراج بيانات الصفحة الرئيسية (الأحدث والأشهر - عام)
// ---------------------------------------------------------
const extractHomePageData = (html) => {
    const topList = [];
    const newList = [];
    const topLinks = new Set();

    const sections = html.split(/<section|<div class="container">|<div class="headWfilter">/i);

    for (let i = 1; i < sections.length; i++) {
        let secHTML = sections[i];
        let secTitle = "";

        let mt = secHTML.match(/class="[^"]*h4[^"]*">\s*([^<]+?)\s*</i) || 
                 secHTML.match(/class="[^"]*h3[^"]*">\s*([^<]+?)\s*</i) || 
                 secHTML.match(/<div class="subHead">[\s\S]*?<div class="h4">\s*([^<]+?)\s*</i);
        if (mt) secTitle = mt[1].trim();

        if (!secTitle) continue;

        const isTopSection = secTitle.includes("الاكثر مشاهدة") || secTitle.includes("الأكثر مشاهدة");
        const isNewSection = secTitle.includes("احدث") || secTitle.includes("أحدث") || 
                             secTitle.includes("جميع") || secTitle.includes("المسلسلات") ||
                             secTitle.includes("الافلام") || secTitle.includes("الأفلام") ||
                             secTitle.includes("البرامج") || secTitle.includes("الأنمي") ||
                             secTitle.includes("الانمي");

        if (isTopSection || isNewSection) {
            let type = "";
            if (secTitle.includes("برنامج") || secTitle.includes("البرامج")) type = "برنامج";
            else if (secTitle.includes("أنمي") || secTitle.includes("انمي") || secTitle.includes("الأنمي") || secTitle.includes("الانمي")) type = "انمي";
            else if (secTitle.includes("مسلسل") || secTitle.includes("المسلسلات")) type = "مسلسل";
            else if (secTitle.includes("فيلم") || secTitle.includes("افلام") || secTitle.includes("أفلام")) type = "فيلم";
            else if (secTitle.includes("اسيوي") || secTitle.includes("أسيوي") || secTitle.includes("الآسيوية")) type = "اسيوي";

            const itemRegex = /<div class="postDiv\s*">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let mItem;
            
            while ((mItem = itemRegex.exec(secHTML)) !== null) {
                let fullItem = mItem[0];
                let link = fullItem.match(/<a href="([^"]+)"/i)?.[1] || "";
                
                if (isTopSection && topLinks.has(link)) continue;
                if (isTopSection) topLinks.add(link);

                let title = fullItem.match(/alt="([^"]+)"/i)?.[1] || "";
                if (title) title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();

                let img = fullItem.match(/data-src="([^"]+)"/i)?.[1] || "";
                
                let quality = "", episodes = "";
                let qMatches = [...fullItem.matchAll(/class="quality">\s*([^<]+?)\s*</gi)];
                if (qMatches.length > 0) quality = qMatches[0][1].trim();
                if (qMatches.length > 1 && qMatches[1][1].includes("حلقة")) episodes = qMatches[1][1].trim();

                let category = fullItem.match(/class="cat">([^<]+)</i)?.[1]?.trim() || "";
                let views = fullItem.match(/class="pViews"[^>]*>[\s\S]*?<\s*\/\s*i\s*>\s*([^<]+?)\s*</i)?.[1]?.trim() || "";
                
                let imdb = fullItem.match(/class="pImdb"[^>]*>[\s\S]*?<\s*\/\s*i\s*>\s*([^<]+?)\s*</i)?.[1]?.trim() || 
                           fullItem.match(/<span>\s*<i\s+class="fa fa-star"><\/i>\s*([^<]+?)\s*</i)?.[1]?.trim() || "";

                const jsonItem = { title, link, image: img, quality, category, views, imdb, type };
                if (episodes) jsonItem.episodes = episodes;

                if (isTopSection) {
                    topList.push(jsonItem);
                    if (topList.length >= 10) break;
                } else {
                    newList.push(jsonItem);
                }
            }
        }
    }
    return { topList, newList };
};


// ---------------------------------------------------------
// 2. دالة استخراج أقسام الصفحة الرئيسية (محددة بـ 6 عناصر)
// ---------------------------------------------------------
const extractHomeCategories = (html) => {
    const result = {
        movies: [],
        asian: [],
        anime: [],
        series: []
    };

    const sections = html.split(/<section/i);

    for (let i = 1; i < sections.length; i++) {
        let secHTML = sections[i];
        let secTitle = "";
        
        let mt = secHTML.match(/class="[^"]*h3[^"]*">\s*([^<]+?)\s*</i);
        if (mt) secTitle = mt[1].trim();

        if (!secTitle) continue;

        // --- 1. الأفلام ---
        if (secTitle.includes("الأفلام")) {
            const itemRegex = /<div class="blockMovie">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let mItem;
            while ((mItem = itemRegex.exec(secHTML)) !== null && result.movies.length < 6) {
                const item = mItem[1];
                const link = item.match(/href="([^"]+)"/i)?.[1] || "";
                let title = item.match(/alt="([^"]+)"/i)?.[1] || "";
                title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();
                
                const image = item.match(/data-src="([^"]+)"/i)?.[1] || "";
                const quality = item.match(/quality">([^<]+)</i)?.[1]?.trim() || "";
                const views = item.match(/bviews">[\s\S]*?<\s*\/\s*i\s*>\s*([^<]+)</i)?.[1]?.trim() || "";
                const category = item.match(/bCat">([^<]+)</i)?.[1]?.trim() || "";
                const imdb = item.match(/bimdb">[\s\S]*?<\s*\/\s*i\s*>\s*([^<]+)</i)?.[1]?.trim() || "";

                result.movies.push({ title, link, image, quality, views, category, imdb });
            }
        }
        // --- 2. الأسيوية ---
        else if (secTitle.includes("الأسيوية")) {
            const itemRegex = /<div class="blockMovie">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let mItem;
            while ((mItem = itemRegex.exec(secHTML)) !== null && result.asian.length < 6) {
                const item = mItem[1];
                const link = item.match(/href="([^"]+)"/i)?.[1] || "";
                let title = item.match(/alt="([^"]+)"/i)?.[1] || "";
                title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();
                
                const image = item.match(/data-src="([^"]+)"/i)?.[1] || "";
                const quality = item.match(/quality">([^<]+)</i)?.[1]?.trim() || "";
                const views = item.match(/bviews">[\s\S]*?<\s*\/\s*i\s*>\s*([^<]+)</i)?.[1]?.trim() || "";
                const category = item.match(/bCat">([^<]+)</i)?.[1]?.trim() || "";

                result.asian.push({ title, link, image, quality, views, category });
            }
        }
        // --- 3. الأنميات ---
        else if (secTitle.includes("الأنميات") || secTitle.includes("انميات")) {
            const itemRegex = /<div class="epDivHome">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let mItem;
            while ((mItem = itemRegex.exec(secHTML)) !== null && result.anime.length < 6) {
                const item = mItem[1];
                const link = item.match(/href="([^"]+)"/i)?.[1] || "";
                let title = item.match(/alt="([^"]+)"/i)?.[1] || "";
                title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();
                
                const image = item.match(/data-src="([^"]+)"/i)?.[1] || "";
                const category = item.match(/sCat">([^<]+)</i)?.[1]?.trim() || "";
                const year = item.match(/sCat">[^<]+<\s*\/\s*span\s*>\s*<span>([^<]+)</i)?.[1]?.trim() || "";

                result.anime.push({ title, link, image, category, year });
            }
        }
        // --- 4. الحلقات المضافة (المسلسلات) ---
        else if (secTitle.includes("الحلقات المضافة") || secTitle.includes("مسلسلات")) {
            const itemRegex = /<div class="epDivHome">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let mItem;
            while ((mItem = itemRegex.exec(secHTML)) !== null && result.series.length < 6) {
                const item = mItem[1];
                const link = item.match(/href="([^"]+)"/i)?.[1] || "";
                let title = item.match(/alt="([^"]+)"/i)?.[1] || "";
                title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();
                
                const image = item.match(/data-src="([^"]+)"/i)?.[1] || "";
                const status = item.match(/epStatus">([^<]+)</i)?.[1]?.trim() || "";
                const count = item.match(/<span>(\d+\s*حلقة)</i)?.[1] || "";

                result.series.push({ title, link, image, status, episodes_count: count });
            }
        }
    }

    return result;
};


// =========================================================
// المسارات (Routes)
// =========================================================

// مسارات الصفحة الرئيسية العامة
app.get('/api/page', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([emptyResponse]);
    const data = extractHomePageData(html);
    res.json(data.newList.length > 0 ? data.newList : [emptyResponse]);
});

app.get('/api/pagetop', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([emptyResponse]);
    const data = extractHomePageData(html);
    res.json(data.topList.length > 0 ? data.topList : [emptyResponse]);
});

// مسارات الصفحة الرئيسية المخصصة (أفلام، مسلسلات، الخ)
app.get('/api/homemovie', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);
    const data = extractHomeCategories(html);
    res.json(data.movies);
});

app.get('/api/homeseries', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);
    const data = extractHomeCategories(html);
    res.json(data.series);
});

app.get('/api/homeasian', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);
    const data = extractHomeCategories(html);
    res.json(data.asian);
});

app.get('/api/homeanime', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);
    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);
    const data = extractHomeCategories(html);
    res.json(data.anime);
});

// استخراج البيانات الأساسية (تفاصيل وسيرفرات المشاهدة)
app.get('/api/details', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);

    // استخدام التعبير المحدث لمعالجة المسافات
    let title = html.match(/<div class="h1 title">([\s\S]*?)<\/div>/i)?.[1]?.trim() || "";
    if (title) title = title.replace(pCleanup, "").replace(pHtmlEntity, "").trim();

    const poster = html.match(/<div class="posterImg">[\s\S]*?<img[^>]*src="([^"]+)"/i)?.[1] || "";
    const rating = html.match(/<span class="singleStar">[\s\S]*?<strong>([^<]+)<\/strong>/i)?.[1]?.trim() || "";
    
    let description = html.match(/<div class="singleDesc">[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1]?.trim() || "";
    description = description.replace(/\r?\n|\r/g, " ").replace(/"/g, "\\\"");

    const category = html.match(/تصنيف[^:]*:\s*<a[^>]*rel="tag">([^<]+)</i)?.[1]?.trim() || "";
    const quality = html.match(/جودة[^:]*:\s*<a[^>]*>([^<]+)</i)?.[1]?.trim() || "";
    const year = html.match(/(?:سنة الإنتاج|موعد الصدور)[^:]*:\s*(?:<a[^>]*>)?([^<]+?)(?:<\/a>)?\s*(?:<\/span>|$)/i)?.[1]?.trim() || "";
    const duration = html.match(/(?:مدة[^:]*:|توقيت[^:]*:)\s*([^<]+?)\s*(?:<\/span>|$)/i)?.[1]?.trim() || "";
    const itemId = html.match(/رقم[^:]*:\s*#?(\d+)/i)?.[1]?.trim() || "";
    const shortLink = html.match(/id="liskSh">([^<]+)</i)?.[1]?.trim() || "";
    const watchLevel = html.match(/(?:مستوى المشاهدة|مستوي المشاهدة)[^:]*:\s*<a[^>]*>([^<]+)</i)?.[1]?.trim() || "";
    const status = html.match(/حالة[^:]*:\s*<a[^>]*>([^<]+)</i)?.[1]?.trim() || "";
    const episodesCount = html.match(/الحلقات[^:]*:\s*(\d+)\s*حلقة/i)?.[1]?.trim() || "";
    const country = html.match(/دولة[^:]*:\s*([^<]+?)\s*(?:<\/span>|$)/i)?.[1]?.trim() || "";
    const language = html.match(/لغة[^:]*:\s*([^<]+?)\s*(?:<\/span>|$)/i)?.[1]?.trim() || "";

    const serversData = {};
    const mServers = [...html.matchAll(/player_iframe\.location\.href\s*=\s*'([^']+)'/gi)];
    mServers.forEach((match, index) => {
        serversData[`servers${index + 1}`] = match[1].replace(/&amp;/g, "&"); 
    });

    const dataJson = {
        title, poster, rating, description, year, duration, quality, 
        watch_level: watchLevel, id: itemId, short_link: shortLink, categories: category,
        ...serversData
    };

    if (status) dataJson.status = status;
    if (episodesCount) dataJson.episodes_count = episodesCount;
    if (country) dataJson.country = country;
    if (language) dataJson.language = language;

    res.json([dataJson]);
});


// استخراج المواسم
app.get('/api/sezon', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);

    const domain = html.match(/id="liskSh">(https?:\/\/[^\/]+)/i)?.[1] || "";
    const seasonList = [];
    
    const seasonSection = html.match(/<div class="seasonLoop">([\s\S]*?)(?=<div class="col-xl-12|<\/div>\s*<\/div>\s*$)/i);
    
    if (seasonSection) {
        const seasonHTML = seasonSection[1];
        const mSeasonRegex = /<div class="seasonDiv[^"]*"[^>]*onclick="window\.location\.href\s*=\s*'([^']+)'[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
        let mSeason;

        while ((mSeason = mSeasonRegex.exec(seasonHTML)) !== null) {
            const seasonLink = mSeason[1];
            const seasonContent = mSeason[2];

            const poster = seasonContent.match(/data-src="([^"]+)"/i)?.[1] || "";
            // استخدام التعبير المحدث لمعالجة المسافات
            const title = seasonContent.match(/<div class="title">([\s\S]*?)<\/div>/i)?.[1]?.trim() || "";
            const views = seasonContent.match(/<i class="fa fa-eye"><\/i>\s*([^<]+)</i)?.[1]?.trim() || "";
            
            let fullLink = seasonLink;
            if (domain && seasonLink.startsWith("/")) {
                fullLink = domain + seasonLink;
            }

            seasonList.push({ title, link: fullLink, poster, views });
        }
    }

    res.json(seasonList);
});


// استخراج الحلقات
app.get('/api/eclip', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    const html = await fetchHtmlContent(targetUrl);
    if (!html) return res.json([]);

    const episodeList = [];
    const mEpisodeRegex = /<a href="([^"]+)"[^>]*>\s*الحلقة\s+(\d+)\s*<\/a>/gi;
    let mEpisode;

    while ((mEpisode = mEpisodeRegex.exec(html)) !== null) {
        const link = mEpisode[1];
        const number = mEpisode[2];
        const title = `الحلقة ${number}`;

        episodeList.push({ number, title, link });
    }

    res.json(episodeList);
});







// =========================================================
// استخراج الحلقه التاليه 
// =========================================================
app.get('/api/nextepisode', async (req, res) => {
    const currentUrl = req.query.url;
    // إرجاع مصفوفة فارغة إذا لم يتم إرسال رابط
    if (!currentUrl) return res.json([]);

    // 1. جلب صفحة الحلقة الحالية
    const currentHtml = await fetchHtmlContent(currentUrl);
    // إرجاع مصفوفة فارغة إذا فشل جلب الصفحة
    if (!currentHtml) return res.json([]);

    // 2. تجميع كل الحلقات لمعرفة من هي الحلقة التالية
    const episodeRegex = /<a href="([^"]+)"([^>]*)>\s*(الحلقة\s+\d+)\s*<\/a>/gi;
    let episodes = [];
    let match;
    
    while ((match = episodeRegex.exec(currentHtml)) !== null) {
        episodes.push({
            link: match[1],
            attributes: match[2],
            title: match[3]
        });
    }

    let nextEpisodeLink = "";
    let nextEpisodeTitle = "";

    // البحث عن الحلقة المفعلة "active" وأخذ الحلقة التي بعدها
    for (let i = 0; i < episodes.length; i++) {
        if (episodes[i].attributes.includes('active')) {
            // التحقق إذا كان هناك حلقة تالية (ليست الحلقة الأخيرة)
            if (i + 1 < episodes.length) {
                nextEpisodeLink = episodes[i + 1].link;
                nextEpisodeTitle = episodes[i + 1].title;
            }
            break;
        }
    }

    // إذا لم يجد حلقة تالية (هذه آخر حلقة) يرجع []
    if (!nextEpisodeLink) {
        return res.json([]);
    }

    // 3. الدخول بذكاء إلى صفحة الحلقة التالية لجلب سيرفراتها
    const nextHtml = await fetchHtmlContent(nextEpisodeLink);
    if (!nextHtml) return res.json([]);

    // استخراج الـ ID للحلقة التالية
    const itemId = nextHtml.match(/رقم[^:]*:\s*#?(\d+)/i)?.[1]?.trim() || "";

    // استخراج السيرفرات للحلقة التالية
    const serversData = {};
    const mServers = [...nextHtml.matchAll(/player_iframe\.location\.href\s*=\s*'([^']+)'/gi)];
    mServers.forEach((match, index) => {
        serversData[`servers${index + 1}`] = match[1].replace(/&amp;/g, "&"); 
    });

    // 4. إرجاع النتيجة النهائية الجاهزة محاطة بـ [ ]
    res.json([{
        title: nextEpisodeTitle,
        link: nextEpisodeLink,
        id: itemId,
        ...serversData
    }]);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`السيرفر يعمل بنجاح، استمتع بالبرمجة! المنفذ: ${PORT}`);
});
