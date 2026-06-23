import "dotenv/config";
import stremio from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = stremio;
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
// console.log(process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";

let cachedManifest = null;
let geminiBlueprints = [];
let cacheExpiration = 0;
const CACHE_DURATION = 6 * 60 * 60 * 1000;
let moviePage = 1;
let seriesPage = 1;

// Helper to look up an absolute IMDb ID from a TMDB ID to preserve cross-addon streaming links
async function getImdbId(tmdbId, type) {
    const tmdbType = type === "series" ? "tv" : "movie";
    try {
        const res = await axios.get(`${TMDB_BASE}/${tmdbType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
        return res.data.imdb_id || `tt_fallback_${tmdbId}`;
    } catch {
        return `tt_fallback_${tmdbId}`;
    }
}

async function generateNetflixRowBlueprints() {
    const prompt = `You are a Netflix executive. Design 12 human homepage row concepts tailored for general crowds. Return a strict JSON array matching this exact schema: [{"id": "g_1", "title": "Gritty Crime Thrillers", "vibe": "dark crime movies", "type": "movie"}]`;
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });
        return JSON.parse(response.text);
    } catch {
        return [
            { id: "g_1", title: "Edge-of-Your-Seat Thrillers", vibe: "suspense", type: "movie" },
            { id: "g_2", title: "Compelling Docuseries", vibe: "true crime", type: "series" },
            { id: "g_3", title: "Laugh-Out-Loud Comedies", vibe: "comedy", type: "movie" },
            { id: "g_4", title: "Binge-Worthy TV Dramas", vibe: "drama", type: "series" }
        ];
    }
}

async function fetchTMDBDiscover(vibeStr, type, page = 1) {
    const tmdbType = type === "series" ? "tv" : "movie";
    let url = `${TMDB_BASE}/discover/${tmdbType}?api_key=${TMDB_API_KEY}&sort_by=popularity.desc&page=${page}`;
    try {
        const res = await axios.get(url);
        const items = res.data.results || [];
        return await Promise.all(items.map(async (item) => {
            const imdbId = await getImdbId(item.id, type);
            return {
                id: imdbId,
                type: type,
                name: item.title || item.name,
                poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
                background: `https://image.tmdb.org/t/p/original${item.backdrop_path}`,
                description: item.overview
            };
        }));
    } catch { return []; }
}

// Global search interface function mapped to TMDB multi-search functionality
async function executeUniversalSearch(query, type) {
    const tmdbType = type === "series" ? "tv" : "movie";
    try {
        const searchRes = await axios.get(`${TMDB_BASE}/search/${tmdbType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
        const items = searchRes.data.results || [];
        return await Promise.all(items.map(async (item) => {
            const imdbId = await getImdbId(item.id, type);
            return {
                id: imdbId,
                type: type,
                name: item.title || item.name,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
                background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
                description: item.overview
            };
        }));
    } catch { return []; }
}

async function getAddonInterface() {
    const now = Date.now();
    
    if (!cachedManifest || now > cacheExpiration) {
        geminiBlueprints = await generateNetflixRowBlueprints();
        
        const dynamicCatalogs = geminiBlueprints.map(blueprint => ({
            id: blueprint.id,
            name: blueprint.title,
            type: blueprint.type,
        }));

        cachedManifest = {
            id: "community.netflix.complete.engine",
            version: "6.0.0",
            name: "Netflix Home",
            description: "Fully interactive dynamic layout engine supporting discovery, search, and detail maps.",
            // -- DEFINES INTERACTION FEATURES SUPPORTED BY THE BACKEND PIPELINE
            resources: ["catalog", "meta"], 
            types: ["movie", "series"],
            idPrefixes: ["tt"],
            catalogs: [
                { 
                    id: "netflix_movies", 
                    type: "movie", 
                    name: "Netflix Movies Today"
                },
                { 
                    id: "netflix_series", 
                    type: "series", 
                    name: "Netflix TV Shows Today"
                },
                ...dynamicCatalogs
            ]
        };
        cacheExpiration = now + CACHE_DURATION;
        moviePage = 1;
        seriesPage = 1;
    }

    const builder = new addonBuilder(cachedManifest);

    // 1 & 2 & 4. HANDLES HOMEPAGE, DISCOVER AND UNIVERSAL SEARCH ROUTING
    builder.defineCatalogHandler(async (args) => {
        // Intercept Search Requests
        if (args.extra && args.extra.search) {
            const results = await executeUniversalSearch(args.extra.search, args.type);
            return { metas: results };
        }

        // Default Layout Configuration Mapping for standard Dashboard load paths
        if (args.id === "netflix_movies") {
            const metas = await fetchTMDBDiscover(null, "movie", moviePage++);
            return { metas };
        }
        if (args.id === "netflix_series") {
            const metas = await fetchTMDBDiscover(null, "series", seriesPage++);
            return { metas };
        }
        
        const matchedBlueprint = geminiBlueprints.find(b => b.id === args.id);
        if (matchedBlueprint) {
            let metas;
            if (matchedBlueprint.type === 'movie') {
                metas = await fetchTMDBDiscover(matchedBlueprint.vibe, "movie", moviePage++);
            } else { // series
                metas = await fetchTMDBDiscover(matchedBlueprint.vibe, "series", seriesPage++);
            }
            return { metas };
        }

        return { metas: [] };
    });

    // 3. HANDLES META DETAIL PAGES (Triggered when clicking any content card)
    builder.defineMetaHandler(async (args) => {
        const tmdbType = args.type === "series" ? "tv" : "movie";
        const cleanImdbId = args.id.replace("tt_fallback_", "");
        
        try {
            // Fetch detailed overview data from TMDB via external lookup mapping parameters
            const findRes = await axios.get(`${TMDB_BASE}/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
            const fallbackItem = findRes.data.movie_results?.[0] || findRes.data.tv_results?.[0];
            const targetId = fallbackItem ? fallbackItem.id : cleanImdbId;

            const detailRes = await axios.get(`${TMDB_BASE}/${tmdbType}/${targetId}?api_key=${TMDB_API_KEY}&append_to_response=credits,videos`);
            const media = detailRes.data;

            const meta = {
                id: args.id,
                type: args.type,
                name: media.title || media.name,
                genres: (media.genres || []).map(g => g.name),
                poster: `https://image.tmdb.org/t/p/w500${media.poster_path}`,
                background: `https://image.tmdb.org/t/p/original${media.backdrop_path}`,
                description: media.overview,
                releaseInfo: media.release_date || media.first_air_date || "",
                runtime: media.runtime ? `${media.runtime}m` : undefined,
                cast: (media.credits?.cast || []).slice(0, 5).map(c => c.name),
                director: media.credits?.crew?.filter(c => c.job === "Director").map(d => d.name)
            };

            // If it's a TV series, map out complete dynamic season and episode matrices natively readable by Nuvio
            if (args.type === "series" && media.seasons) {
                meta.videos = media.seasons
                    .filter(s => s.season_number > 0) // Exclude Specials/Season 0
                    .map(s => ({
                        id: `${args.id}:${s.season_number}:1`, // Base mapping fallback hook structure
                        title: s.name,
                        season: s.season_number,
                        episode: 1,
                        released: s.air_date ? new Date(s.air_date).toISOString() : undefined
                    }));
            }

            return { meta };
        } catch (err) {
            console.error("Detail meta builder intercept failure:", err.message);
            return { meta: {} };
        }
    });

    return builder.getInterface();
}

async function startServer() {
    const addonInterface = await getAddonInterface();
    serveHTTP(addonInterface, { port: 7000 });
    console.log("Full-Stack Interactive Addon Live at http://localhost:7000/manifest.json");
}

startServer();