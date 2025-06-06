import express from 'express';
import cors from 'cors';
import session from 'express-session';
import crypto from 'crypto';
import SpotifyAPI from './core/spotify.js';
import YoutubeAPI from './core/youtube.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { RedisStore } from 'connect-redis';
import Redis from 'ioredis';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

// Workaround per __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 5501;

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:5502'],
    credentials: true
}));
app.use(express.json());

// Inizializza client Redis e store per le sessioni
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableReadyCheck: false,
    maxRetriesPerRequest: 3
});
redisClient.on('error', (err) => console.log('Redis Client Error', err));

// Configurazione Sessione con Redis
app.use(session({
    store: new RedisStore({
        client: redisClient,
        prefix: "freesound-session:",
        ttl: 24 * 60 * 60 // 1 giorno in secondi
    }),
    secret: process.env.SESSION_SECRET || 'un_segreto_molto_segreto_da_cambiare',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // true in produzione
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 1 giorno in millisecondi
    }
}));

// Inizializza le API
const spotifyAPI = new SpotifyAPI();
const youtubeAPI = new YoutubeAPI();

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)){
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// === NUOVI ENDPOINT PER AUTENTICAZIONE SPOTIFY ===
const STATE_KEY = 'spotify_auth_state';

app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_KEY, state, { httpOnly: true });

    const level = req.query.level || 'basic';

    const scopes = {
        basic: [
            'user-read-private',
            'user-read-email',
            'user-library-read',
            'user-top-read',
            'playlist-read-private',
            'playlist-read-collaborative'
        ],
        crud: [
            'playlist-modify-public',
            'playlist-modify-private',
            'user-library-modify'
        ]
    };

    let scope;
    if (level === 'crud') {
        // Unisce basic e crud per l'upgrade dei permessi
        scope = [...new Set([...scopes.basic, ...scopes.crud])].join(' ');
    } else {
        scope = scopes.basic.join(' ');
    }
    
    const authUrl = 'https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
            response_type: 'code',
            client_id: process.env.SPOTIFY_CLIENT_ID,
            scope: scope,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
            state: state
        }).toString();
    
    console.log('Reindirizzamento a Spotify per autorizzazione:', authUrl);
    res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const storedState = req.cookies ? req.cookies[STATE_KEY] : null;

    console.log('Callback da Spotify ricevuto.');
    console.log('Code:', code ? 'Presente' : 'Mancante');
    console.log('State:', state ? state.substring(0,10) + '...' : 'Mancante');
    console.log('Stored State:', storedState ? storedState.substring(0,10) + '...' : 'Mancante');

    if (state === null || state !== storedState) {
        console.error('Errore: state mismatch.');
        res.status(400).send('State mismatch. Riprova ad autenticarti.');
        return;
    }

    res.clearCookie(STATE_KEY);

    try {
        const tokenData = await spotifyAPI.exchangeCodeForTokens(code);
        
        await spotifyAPI.setUserTokens(req.sessionID, tokenData);

        console.log('Token ottenuti e salvati in sessione per sessionID:', req.sessionID.substring(0,5) + '...');
        
        res.redirect('http://localhost:3000/');
    } catch (error) {
        console.error('Errore durante lo scambio del codice o salvataggio token:', error.message, error.response?.data);
        res.status(500).send('Errore durante l\'autenticazione con Spotify.');
    }
});

app.get('/auth/logout', (req, res) => {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
        if (err) {
            console.error("Errore durante la distruzione della sessione:", err);
            return res.status(500).send('Impossibile effettuare il logout');
        }
        spotifyAPI.clearUserTokens(sessionId);
        res.clearCookie('connect.sid');
        console.log('Utente sloggato, sessione distrutta per sessionID:', sessionId.substring(0,5) + '...');
        res.status(200).send('Logout effettuato con successo');
    });
});

app.get('/auth/status', async (req, res) => {
    const tokens = await spotifyAPI.getUserTokens(req.sessionID);
    if (tokens && tokens.access_token) {
        try {
            const userData = await spotifyAPI.getUserProfile(req.sessionID);
             if (userData) {
                res.json({ isAuthenticated: true, user: { displayName: userData.display_name, email: userData.email, id: userData.id } });
            } else {
                res.json({ isAuthenticated: false });
            }
        } catch (error) {
            console.warn("Impossibile ottenere profilo utente con token di sessione (potrebbe essere scaduto e refresh fallito):", error.message);
            res.json({ isAuthenticated: false });
        }
    } else {
        res.json({ isAuthenticated: false });
    }
});

// === ENDPOINT API ESISTENTI (modificati o meno) ===

// Endpoint di ricerca (POST)
app.post('/search', async (req, res) => {
    console.log('Richiesta POST /search ricevuta con body:', req.body);
    try {
        const { query } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: 'Formato richiesta non valido' });
        }

        const decodedQuery = decodeURIComponent(query);
        
        // Usa la nuova ricerca multi-tipo
        const searchResult = await spotifyAPI.searchMultiType(decodedQuery, 20);
        
        if (!searchResult.success) {
            return res.status(404).json({ error: searchResult.message || 'Nessun risultato trovato' });
        }

        // Mantiene compatibilità con il frontend esistente fornendo anche solo le tracce
        const tracksOnly = searchResult.by_type.tracks;

        res.json({
            // Nuova struttura con tutti i tipi
            results: searchResult.results,
            by_type: searchResult.by_type,
            total_found: searchResult.total_found,
            
            // Mantiene compatibilità con il frontend esistente
            tracks: tracksOnly
        });

    } catch (error) {
        console.error('Errore ricerca:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// Endpoint di streaming (GET con ID Spotify nel path e dettagli nella query)
app.get('/stream/:spotify_id', async (req, res) => {
    console.log(`Richiesta GET /stream/${req.params.spotify_id} ricevuta con query:`, req.query);
    try {
        const { spotify_id } = req.params;
        const { title, artist, duration_ms } = req.query;

        if (!spotify_id || !title || !artist || !duration_ms) {
            return res.status(400).send('Parametri mancanti (spotify_id, title, artist, duration_ms)');
        }

        const parsedDurationMs = parseInt(duration_ms, 10);
        if (isNaN(parsedDurationMs)) {
            return res.status(400).send('duration_ms non valida');
        }

        let fileName = `${artist} - ${title}.mp3`;
        fileName = fileName.replace(/[^a-zA-Z0-9\s\-\.]/g, '').replace(/\s+/g, ' ').trim();
        const filePath = path.join(DOWNLOADS_DIR, fileName);

        console.log(`Percorso file richiesto: ${filePath}`);

        if (fs.existsSync(filePath)) {
            console.log(`File trovato in cache: ${fileName}. Streaming...`);
            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
                'Accept-Ranges': 'bytes'
            });
            const stream = fs.createReadStream(filePath);
            stream.on('error', (err) => {
                console.error('Errore durante lo streaming del file dalla cache:', err);
                if (!res.headersSent) {
                    res.status(500).send('Errore durante lo streaming del file.');
                }
                stream.destroy();
            });
            stream.pipe(res);
        } else {
            console.log(`File non trovato: ${fileName}. Download da YouTube in corso...`);
            
            const youtubeQuery = `${artist} ${title}`;
            const youtubeResult = await youtubeAPI.searchAndDownload(
                youtubeQuery,
                parsedDurationMs,
                filePath
            );

            if (!youtubeResult.success || !youtubeResult.path) {
                 console.error('Errore download YouTube:', youtubeResult.message);
                 if (youtubeResult.message && 
                     (youtubeResult.message.toLowerCase().includes("non trovato") || 
                      youtubeResult.message.toLowerCase().includes("filtro") ||
                      youtubeResult.message.toLowerCase().includes("no video found"))) {
                    return res.status(404).send(youtubeResult.message || 'Canzone non trovata su YouTube o non corrisponde ai criteri.');
                 }
                return res.status(500).send(youtubeResult.message || 'Errore durante il download da YouTube');
            }

            console.log(`File scaricato: ${youtubeResult.path}. Streaming...`);
            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
                'Accept-Ranges': 'bytes'
            });
            const stream = fs.createReadStream(youtubeResult.path);
            stream.on('error', (err) => {
                console.error('Errore durante lo streaming del file scaricato:', err);
                if (!res.headersSent) {
                    res.status(500).send('Errore durante lo streaming del file.');
                }
                stream.destroy();
            });
            stream.pipe(res);
        }

    } catch (error) {
        console.error('Errore endpoint /stream:', error);

        let errorMessage = 'Errore sconosciuto durante lo streaming o il download.';
        let statusCode = 500;

        if (error && typeof error.message === 'string') {
            errorMessage = error.message;
            if (error.success === false || error.message) {
                 if (errorMessage.toLowerCase().includes("non trovato") ||
                     errorMessage.toLowerCase().includes("filtro") ||
                     errorMessage.toLowerCase().includes("no video found") ||
                     errorMessage.toLowerCase().includes("nessun video trovato")) {
                    statusCode = 404;
                 } else {
                    statusCode = 500;
                 }
            }
        } else if (error instanceof Error) {
            errorMessage = error.message;
        } else if (typeof error === 'string') {
            errorMessage = error;
        }

        if (!res.headersSent) {
            res.status(statusCode).send(errorMessage);
        }
    }
});

// === NUOVI ENDPOINT API PER PLAYLIST ===

// Endpoint per dettagli artista
app.get('/api/artists/:artistId', async (req, res) => {
    try {
        const { artistId } = req.params;
        if (!artistId) {
            return res.status(400).json({ error: 'ID artista richiesto' });
        }

        const artistDetails = await spotifyAPI.getArtistDetails(artistId);
        
        if (!artistDetails.success) {
            return res.status(404).json({ error: artistDetails.message || 'Artista non trovato' });
        }

        res.json(artistDetails);
    } catch (error) {
        console.error('Errore nel recuperare dettagli artista:', error.message);
        res.status(500).json({ error: 'Errore interno del server nel recuperare dettagli artista' });
    }
});

// Endpoint per dettagli album
app.get('/api/albums/:albumId', async (req, res) => {
    try {
        const { albumId } = req.params;
        if (!albumId) {
            return res.status(400).json({ error: 'ID album richiesto' });
        }

        const albumDetails = await spotifyAPI.getAlbumDetails(albumId);
        
        if (!albumDetails.success) {
            return res.status(404).json({ error: albumDetails.message || 'Album non trovato' });
        }

        res.json(albumDetails);
    } catch (error) {
        console.error('Errore nel recuperare dettagli album:', error.message);
        res.status(500).json({ error: 'Errore interno del server nel recuperare dettagli album' });
    }
});

app.get('/api/me/playlists', async (req, res) => {
    // const tokens = await spotifyAPI.getUserTokens(req.sessionID);
    // if (!tokens || !tokens.access_token) {
    //     return res.status(401).json({ error: 'Utente non autenticato o token mancante.' });
    // }
    try {
        const playlists = await spotifyAPI.getUserPlaylists(req.sessionID);
        res.json(playlists);
    } catch (error) {
        console.error('Errore nel recuperare le playlist dell\'utente:', error.message, error.response?.data);
        if (error.response?.status === 401) {
             spotifyAPI.clearUserTokens(req.sessionID);
             return res.status(401).json({ error: 'Token Spotify non valido o scaduto. Riprova l\'autenticazione.' });
        }
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare le playlist.' });
    }
});

app.get('/api/browse/featured-playlists', async (req, res) => {
    try {
        const playlists = await spotifyAPI.getFeaturedPlaylists(req.sessionID);
        res.json(playlists);
    } catch (error) {
        console.error('Errore nel recuperare le playlist in primo piano:', error.message, error.response?.data);
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare le playlist in primo piano.' });
    }
});

// Endpoint per artisti consigliati
app.get('/api/me/top/artists', async (req, res) => {
    try {
        const artists = await spotifyAPI.getUserTopArtists(req.sessionID);
        res.json(artists);
    } catch (error) {
        console.error('Errore nel recuperare artisti preferiti dell\'utente:', error.message, error.response?.data);
        if (error.response?.status === 401) {
            spotifyAPI.clearUserTokens(req.sessionID);
            return res.status(401).json({ error: 'Token Spotify non valido o scaduto. Riprova l\'autenticazione.' });
        }
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare artisti preferiti.' });
    }
});

// Endpoint per tracce preferite
app.get('/api/me/tracks', async (req, res) => {
    try {
        const tracks = await spotifyAPI.getUserSavedTracks(req.sessionID);
        res.json(tracks);
    } catch (error) {
        console.error('Errore nel recuperare tracce salvate dell\'utente:', error.message, error.response?.data);
        if (error.response?.status === 401) {
            spotifyAPI.clearUserTokens(req.sessionID);
            return res.status(401).json({ error: 'Token Spotify non valido o scaduto. Riprova l\'autenticazione.' });
        }
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare tracce salvate.' });
    }
});

// Endpoint per tracce di una playlist specifica
app.get('/api/playlists/:playlistId/tracks', async (req, res) => {
    try {
        const { playlistId } = req.params;
        const { limit = 50, offset = 0 } = req.query;
        
        if (!playlistId) {
            return res.status(400).json({ error: 'ID playlist richiesto' });
        }

        const playlistTracks = await spotifyAPI.getPlaylistTracks(playlistId, limit, offset);
        
        if (!playlistTracks.success) {
            return res.status(404).json({ error: playlistTracks.message || 'Playlist non trovata' });
        }

        res.json(playlistTracks);
    } catch (error) {
        console.error('Errore nel recuperare tracce playlist:', error.message, error.response?.data);
        if (error.response?.status === 401) {
            spotifyAPI.clearUserTokens(req.sessionID);
            return res.status(401).json({ error: 'Token Spotify non valido o scaduto. Riprova l\'autenticazione.' });
        }
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare tracce playlist.' });
    }
});

// Endpoint per ottenere playlist consigliate basate su una traccia
app.get('/api/recommendations/playlists', async (req, res) => {
    try {
        const { seed_tracks, seed_artists, seed_genres } = req.query;
        
        if (!seed_tracks && !seed_artists && !seed_genres) {
            return res.status(400).json({ error: 'Almeno un parametro seed è richiesto (seed_tracks, seed_artists, o seed_genres)' });
        }

        const recommendations = await spotifyAPI.getRecommendations({
            seed_tracks,
            seed_artists, 
            seed_genres,
            limit: 20
        });
        
        if (!recommendations.success) {
            return res.status(404).json({ error: recommendations.message || 'Nessuna raccomandazione trovata' });
        }

        res.json(recommendations);
    } catch (error) {
        console.error('Errore nel recuperare raccomandazioni:', error.message, error.response?.data);
        if (error.response?.status === 401) {
            spotifyAPI.clearUserTokens(req.sessionID);
            return res.status(401).json({ error: 'Token Spotify non valido o scaduto. Riprova l\'autenticazione.' });
        }
        res.status(error.response?.status || 500).json({ error: 'Errore interno del server nel recuperare raccomandazioni.' });
    }
});

// Endpoint aggregato per i contenuti della Home Page
app.get('/api/home/content', async (req, res) => {
    try {
        const [featuredPlaylists, userTopArtists] = await Promise.all([
            spotifyAPI.getFeaturedPlaylists(req.sessionID),
            // Se l'utente è loggato, prendi i suoi artisti top, altrimenti potremmo prendere una classifica globale
            spotifyAPI.getUserTopArtists(req.sessionID).catch(() => null) 
        ]);

        const response = {
            featuredPlaylists: {
                title: 'Playlist in Evidenza',
                items: featuredPlaylists || []
            }
        };

        if (userTopArtists && userTopArtists.length > 0) {
            response.topArtists = {
                title: 'I tuoi Artisti del Momento',
                items: userTopArtists.map(artist => ({...artist, type: 'artist'}))
            };
        }
        
        // In futuro si possono aggiungere altre sezioni qui (es. Nuove uscite, album popolari)

        res.json(response);

    } catch (error) {
        console.error('Errore nel recuperare contenuti per la home:', error.message);
        res.status(500).json({ error: 'Errore interno del server nel recuperare i contenuti.' });
    }
});

// Avvio server
app.listen(port, () => {
    console.log(`Server in ascolto su http://localhost:${port}`);
    console.log(`Assicurati che SPOTIFY_CLIENT_ID, SPOTIFY_SECRET_ID, e SPOTIFY_REDIRECT_URI siano configurati nel file .env`);
    console.log(`SPOTIFY_REDIRECT_URI dovrebbe essere: http://localhost:${port}/auth/callback`);
});
