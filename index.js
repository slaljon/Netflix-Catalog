
      const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      const axios = require("axios");
      
      // Load environment variables
      require('dotenv').config();

      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const TMDB_API_KEY = process.env.TMDB_API_KEY;
      const FLIXPATROL_API_KEY = process.env.FLIXPATROL_API_KEY;
      const TMDB_BASE = "https://api.themoviedb.org/3";
      const FLIXPATROL_BASE = "https://api.flixpatrol.com/v2";
      const TARGET_COUNTRY = "united-states";
      
      let cachedManifest = null;
      let geminiBlueprints = [];
      let cacheExpiration = 0;
      const CACHE_DURATION = 6 * 60 * 60 * 1000;
      
      async function getImdbId(tmdbId, type) {
          const tmdbType = type === "series" ? "tv" : "movie";
          try {
              const res = await axios.get(`${TMDB_BASE}/${tmdbType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
              return res.data.imdb_id || `tt_fallback_${tmdbId}`;
          } catch {
              return `tt_fallback_${tmdbId}`;
          }
      }

      async function getTMDBData(tmdbId, type) {
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        try {
            const res = await axios.get(`${TMDB_BASE}/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}`);
            return res.data;
        } catch {
            return null;
        }
    }
      
      async function fetchFlixPatrolTop10(type) {
          try {
              const flixType = type === "movie" ? "movies" : "tv";
              const response = await axios.get(`${FLIXPATROL_BASE}/rankings/${TARGET_COUNTRY}/${flixType}`, {
                  auth: { username: FLIXPATROL_API_KEY, password: "" }
              });
              return (response.data.results || []).slice(0, 10).map(item => ({ title: item.title, tmdb_id: item.tmdb_id }));
          } catch (error) {
              console.error("Error fetching from FlixPatrol:", error.message);
              if (type === "movie") {
                  return [{ title: "The Gorge", tmdb_id: "94605" }, { title: "Greyhound", tmdb_id: "516486" }];
              } else {
                  return [{ title: "House of the Dragon", tmdb_id: "94997" }, { title: "Silo", tmdb_id: "103768" }];
              }
          }
      }
      
      async function searchTMDB(query, type) {
          const searchType = type === "series" ? "tv" : "movie";
          try {
              const res = await axios.get(`${TMDB_BASE}/search/${searchType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
              return res.data.results[0] || null;
          } catch {
              return null;
          }
      }
      
     async function generateNetflixRowBlueprints() {
         const prompt = `You are a Netflix executive. Design 4 human homepage row concepts tailored for general crowds. Return a strict JSON array matching this exact schema: [{"id": "g_1", "title": "Gritty Crime Thrillers", "vibe": "dark crime movies", "type": "movie"}]`;
         try {
             const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
             const result = await model.generateContent(prompt);
             const response = await result.response;
             return JSON.parse(response.text());
         } catch {
             return [
                 { id: "g_1", title: "Edge-of-Your-Seat Thrillers", vibe: "suspense", type: "movie" },
                 { id: "g_2", title: "Compelling Docuseries", vibe: "true crime", type: "series" }
             ];
         }
     }
      
     async function generateTitlesForVibe(vibe, type) {
        const prompt = `Give me a list of 10 ${vibe} titles in a JSON array like this: ["title_1", "title_2"]`;
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro"});
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return JSON.parse(response.text());
        } catch {
            return [];
        }
    }
      
    async function resolveTitleToMeta(item, type) {
        try {
            const tmdbData = item.tmdb_id ? await getTMDBData(item.tmdb_id, type) : await searchTMDB(item.title, type);
            if (!tmdbData) return null;
    
            const imdbId = await getImdbId(tmdbData.id, type);
            const meta = {
                id: imdbId,
                type: type,
                name: tmdbData.title || tmdbData.name,
                poster: `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`,
                background: `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`,
                description: tmdbData.overview,
                releaseInfo: (tmdbData.release_date || tmdbData.first_air_date || "").substring(0, 4),
                imdbRating: tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : null
            };
            return meta;
        } catch(e) {
            console.error("Error in resolveTitleToMeta", e.message)
            return null;
        }
    }

      
     async function getAddonInterface() {
         const now = Date.now();
         
         if (!cachedManifest || now > cacheExpiration) {
             geminiBlueprints = await generateNetflixRowBlueprints();
             
             cachedManifest = {
                 id: "community.netflix.complete.engine",
                 version: "6.0.0",
                 name: "Netflix Home",
                 description: "Fully interactive dynamic layout engine supporting discovery, search, and detail maps.",
                 resources: ["catalog", "meta"], 
                 types: ["movie", "series"],
                 idPrefixes: ["tt"],
                 catalogs: [
                     { 
                         id: "netflix_movies", 
                         type: "movie", 
                         name: "Netflix Movies Today",
                         extra: [{ name: "search", optional: true }, { name: "genre", optional: true }]
                     },
                     {
                         id: "netflix_series",
                         type: "series",
                         name: "Netflix Series Today",
                         extra: [{ name: "search", optional: true }, { name: "genre", optional: true }]
                     },
                     ...geminiBlueprints.map(b => ({
                         id: b.id,
                         type: b.type,
                         name: b.title,
                         extra: [{ name: "search", isRequired: false }]
                     }))
                 ]
             };
             cacheExpiration = now + CACHE_DURATION;
         }
         return cachedManifest;
     }
      
     const builder = new addonBuilder(await getAddonInterface());
      
     builder.defineCatalogHandler(async (args) => {
         const isSearch = args.extra && args.extra.search;
         const blueprint = geminiBlueprints.find(b => b.id === args.id);
      
         if (blueprint) {
             const titles = isSearch ? [args.extra.search] : await generateTitlesForVibe(blueprint.vibe, blueprint.type);
             const metas = await Promise.all(titles.map(t => resolveTitleToMeta({ title: t }, blueprint.type)));
             return { metas: metas.filter(Boolean) };
         }
      
         if (args.id === "netflix_movies") {
             const items = await fetchFlixPatrolTop10("movie");
             const metas = await Promise.all(items.map(item => resolveTitleToMeta(item, "movie")));
             return { metas: metas.filter(Boolean) };
         }
      
         if (args.id === "netflix_series") {
             const items = await fetchFlixPatrolTop10("series");
             const metas = await Promise.all(items.map(item => resolveTitleToMeta(item, "series")));
             return { metas: metas.filter(Boolean) };
         }
      
         return { metas: [] };
     });
      
     builder.defineMetaHandler(async (args) => {
         const [type, tmdbId] = args.id.split("_fallback_");
         if (tmdbId) {
             const meta = await resolveTitleToMeta({ tmdb_id: tmdbId }, type === "series" ? "series" : "movie");
             return { meta };
         }
         return { meta: null };
     });
      
     serveHTTP(builder.getInterface(), { port: process.env.PORT || 7700 });
      