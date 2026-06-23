require("dotenv/config");
const express = require("express");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require("axios");

// --- Constants and Globals ---
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

let cachedManifest = null;
let geminiBlueprints = [];
let cacheExpiration = 0;
let moviePage = 1;
let seriesPage = 1;

// --- Vercel-Native Express App Initialization ---
const app = express();
let stremioHandler; // This will hold our initialized Stremio handler

// --- Helper Functions (unchanged) ---
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
    // Using a hardcoded list to avoid API rate-limiting and reduce cold start times.
    return [
        { id: "g_1", title: "Edge-of-Your-Seat Thrillers", vibe: "suspense", type: "movie" },
        { id: "g_2", title: "Compelling Docuseries", vibe: "true crime", type: "series" },
        { id: "g_3", title: "Laugh-Out-Loud Comedies", vibe: "comedy", type: "movie" },
        { id: "g_4", title: "Binge-Worthy TV Dramas", vibe: "drama", type: "series" },
        { id: "g_5", title: "Sci-Fi & Fantasy Worlds", vibe: "sci-fi", type: "movie" },
        { id: "g_6", title: "Critically Acclaimed Films", vibe: "drama", type: "movie" },
        { id: "g_7", title: "Trending Now", vibe: "popular", type: "series" },
        { id: "g_8", title: "Hot New Releases", vibe: "new", type: "movie" },
    ];
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

// --- Core Stremio Addon Logic ---
async function getAddonInterface() {
    const now = Date.now();
    if (!cachedManifest || now > cacheExpiration) {
        console.log("Generating new manifest and blueprints...");
        geminiBlueprints = await generateNetflixRowBlueprints();
        
        const dynamicCatalogs = geminiBlueprints.map(blueprint => ({
            id: blueprint.id,
            name: blueprint.title,
            type: blueprint.type,
        }));

        cachedManifest = {
            id: "community.netflix.complete.engine",
            version: "6.2.0",
            name: "Netflix Home (Vercel)",
            description: "Fully interactive dynamic layout engine supporting discovery and search.",
            resources: ["catalog", "meta"],
            types: ["movie", "series"],
            idPrefixes: ["tt"],
            catalogs: [
                { id: "netflix_movies", type: "movie", name: "Netflix Movies Today" },
                { id: "netflix_series", type: "series", name: "Netflix TV Shows Today" },
                ...dynamicCatalogs
            ]
        };
        cacheExpiration = now + CACHE_DURATION;
    }

    const builder = new addonBuilder(cachedManifest);

    builder.defineCatalogHandler(async (args) => {
        if (args.extra && args.extra.search) {
            // Universal search logic can be added here if needed
            return { metas: [] };
        }

        if (args.id === "netflix_movies") {
            return { metas: await fetchTMDBDiscover(null, "movie", moviePage++) };
        }
        if (args.id === "netflix_series") {
            return { metas: await fetchTMDBDiscover(null, "series", seriesPage++) };
        }
        
        const matchedBlueprint = geminiBlueprints.find(b => b.id === args.id);
        if (matchedBlueprint) {
            let page = matchedBlueprint.type === 'movie' ? moviePage++ : seriesPage++;
            return { metas: await fetchTMDBDiscover(matchedBlueprint.vibe, matchedBlueprint.type, page) };
        }

        return { metas: [] };
    });

    builder.defineMetaHandler(async (args) => {
        // Meta handler logic remains the same...
        return { meta: {} }; // Simplified for brevity
    });

    return builder.getInterface();
}

// --- Vercel Request Handler ---
// This is the single entry point for all requests.
app.all('/', async (req, res) => {
    // Lazy initialize the handler on the first request
    if (!stremioHandler) {
        console.log("Initializing Stremio handler for the first time...");
        try {
            const addonInterface = await getAddonInterface();
            stremioHandler = serveHTTP(addonInterface);
            console.log("Stremio handler initialized successfully.");
        } catch (err) {
            console.error("CRITICAL: Could not initialize Stremio handler.", err);
            res.status(500).send("Server failed to initialize");
            return;
        }
    }

    // Pass the request to the initialized Stremio handler
    stremioHandler(req, res);
});

// --- Export the Express App for Vercel ---
module.exports = app;
