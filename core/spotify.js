import SpotifyWebApi from 'spotify-web-api-node';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import Redis from 'ioredis';

dotenv.config();

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
const SPOTIFY_ACCOUNTS_BASE_URL = 'https://accounts.spotify.com/api';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 giorni

export default class SpotifyAPI {
    constructor() {
        this.clientId = process.env.SPOTIFY_CLIENT_ID;
        this.clientSecret = process.env.SPOTIFY_SECRET_ID;
        this.redirectUri = process.env.SPOTIFY_REDIRECT_URI;
        
        this.redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: false
        });

        this.redis.on('error', (err) => {
            console.error('Errore connessione Redis:', err);
        });

        this.clientCredentialsToken = null;
        this.clientCredentialsTokenExpiresAt = null;
    }

    _getSessionKey(sessionId) {
        return `session-token:${sessionId}`;
    }

    async getClientCredentialsToken() {
        if (this.clientCredentialsToken && this.clientCredentialsTokenExpiresAt > Date.now()) {
            return this.clientCredentialsToken;
        }

        try {
            console.log('Richiesta nuovo token client credentials...');
            const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(
                        `${this.clientId}:${this.clientSecret}`
                    ).toString('base64')
                },
                body: 'grant_type=client_credentials'
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`Errore HTTP ${response.status} nel recupero del token client: ${errorBody}`);
            }

            const data = await response.json();
            this.clientCredentialsToken = data.access_token;
            this.clientCredentialsTokenExpiresAt = Date.now() + data.expires_in * 1000;
            console.log('Nuovo token client credentials ottenuto.');
            return this.clientCredentialsToken;
        } catch (error) {
            console.error('Errore grave nel recupero del token client credentials:', error.message);
            throw error;
        }
    }

    async exchangeCodeForTokens(code) {
        try {
            // console.log(`Tentativo di scambiare codice per token... Code: ${code ? code.substring(0,10)+'...\' : "N/D"}`)
            const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: this.redirectUri
                })
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => response.text());
                console.error('Errore nello scambio codice per token:', response.status, errorBody);
                throw new Error(`Errore HTTP ${response.status} nello scambio codice: ${JSON.stringify(errorBody)}`);
            }
            const tokenData = await response.json();
            console.log('Token utente ottenuti con successo tramite codice.');
            return tokenData;
        } catch (error) {
            console.error('Errore in exchangeCodeForTokens:', error.message);
            throw error;
        }
    }

    async setUserTokens(sessionId, tokenData) {
        if (!sessionId || !tokenData || !tokenData.access_token) {
            console.error('setUserTokens: sessionId o tokenData non validi.');
            return;
        }
        const sessionKey = this._getSessionKey(sessionId);
        const sessionPayload = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
            scope: tokenData.scope
        };
        await this.redis.set(sessionKey, JSON.stringify(sessionPayload), 'EX', SESSION_TTL_SECONDS);
        console.log(`Token utente salvati/aggiornati su Redis per sessionID: ${sessionId.substring(0,5)}...`);
    }

    async refreshUserAccessToken(sessionId) {
        const sessionKey = this._getSessionKey(sessionId);
        const sessionDataString = await this.redis.get(sessionKey);

        if (!sessionDataString) {
             console.warn(`Nessun dato di sessione trovato su Redis per sessionID ${sessionId.substring(0,5)}...`);
             return null;
        }
        const sessionData = JSON.parse(sessionDataString);

        if (!sessionData || !sessionData.refreshToken) {
            console.warn(`Refresh token non trovato per sessionID ${sessionId.substring(0,5)}... Impossibile refreshare.`);
            await this.redis.del(sessionKey);
            return null;
        }

        console.log(`Tentativo di refresh access token per sessionID: ${sessionId.substring(0,5)}...`);
        try {
            const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: sessionData.refreshToken
                })
            });

            if (!response.ok) {
                const errorBody = await response.json().catch(() => response.text());
                console.error(`Errore durante il refresh del token per sessionID ${sessionId.substring(0,5)}...:`, response.status, errorBody);
                if (response.status === 400 || response.status === 401) {
                    await this.redis.del(sessionKey);
                }
                throw new Error(`Errore HTTP ${response.status} durante il refresh del token: ${JSON.stringify(errorBody)}`);
            }

            const newTokenData = await response.json();
            const newRefreshToken = newTokenData.refresh_token || sessionData.refreshToken;
            
            await this.setUserTokens(sessionId, {
                ...newTokenData,
                refresh_token: newRefreshToken
            });

            const updatedSessionString = await this.redis.get(sessionKey);
            const updatedSessionData = JSON.parse(updatedSessionString);

            console.log(`Access token refreshato con successo per sessionID: ${sessionId.substring(0,5)}...`);
            return updatedSessionData.accessToken;
        } catch (error) {
            console.error(`Errore grave durante il refresh del token per sessionID ${sessionId.substring(0,5)}...:`, error.message);
            throw error;
        }
    }

    async getUserTokens(sessionId) {
        if (!sessionId) {
            return null;
        }
        const sessionKey = this._getSessionKey(sessionId);
        const sessionDataString = await this.redis.get(sessionKey);

        if (!sessionDataString) {
            return null;
        }

        let sessionData = JSON.parse(sessionDataString);
        
        if (sessionData.expiresAt <= Date.now() + 60000) { // 60 secondi di margine
            try {
                const newAccessToken = await this.refreshUserAccessToken(sessionId);
                if (!newAccessToken) return null;

                const updatedSessionString = await this.redis.get(sessionKey);
                sessionData = JSON.parse(updatedSessionString);

            } catch (refreshError) {
                console.error(`getUserTokens: Fallito il refresh per sessionID ${sessionId.substring(0,5)}...`, refreshError.message);
                return null;
            }
        }
        return {
            access_token: sessionData.accessToken,
            refresh_token: sessionData.refreshToken,
        };
    }

    async clearUserTokens(sessionId) {
        const sessionKey = this._getSessionKey(sessionId);
        const result = await this.redis.del(sessionKey);
        if (result > 0) {
            console.log(`Token utente rimossi da Redis per sessionID: ${sessionId.substring(0,5)}...`);
        }
    }

    async _getWithCache(key, fetcher, ttlSeconds = 3600) { // Default TTL 1 ora
        try {
            const cachedData = await this.redis.get(key);
            if (cachedData) {
                console.log(`[CACHE HIT] Key: ${key}`);
                return JSON.parse(cachedData);
            }
        } catch (error) {
            console.error(`[CACHE ERROR] Errore lettura da Redis per key ${key}:`, error);
        }

        console.log(`[CACHE MISS] Key: ${key}`);
        const freshData = await fetcher();
        
        if (freshData) {
            try {
                // Non cachare risposte di errore esplicite
                if (freshData.success === false) return freshData;
                
                await this.redis.set(key, JSON.stringify(freshData), 'EX', ttlSeconds);
            } catch (error) {
                 console.error(`[CACHE ERROR] Errore scrittura su Redis per key ${key}:`, error);
            }
        }
       
        return freshData;
    }

    async _makeApiRequest(sessionId, endpoint, method = 'GET', body = null) {
        let accessToken;
        if (sessionId) {
            const userTokens = await this.getUserTokens(sessionId);
            if (userTokens && userTokens.access_token) {
                accessToken = userTokens.access_token;
            } else {
                console.warn(`_makeApiRequest: Nessun token utente valido per sessionID ${sessionId.substring(0,5)}... per endpoint ${endpoint}`);
            }
        }

        if (!accessToken) {
            try {
                accessToken = await this.getClientCredentialsToken();
            } catch (clientTokenError) {
                throw new Error(`Impossibile ottenere token per la richiesta API: ${clientTokenError.message}`);
            }
        }
        
        if (!accessToken) {
            throw new Error('Nessun access token (utente o client) disponibile per la richiesta API.');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };
        const config = { method, headers };
        if (body) {
            config.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(`${SPOTIFY_API_BASE_URL}${endpoint}`, config);
            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({ message: response.statusText, status: response.status }));
                console.error(`Errore API Spotify (${response.status}) per ${method} ${endpoint}:`, errorBody);
                const err = new Error(errorBody.error?.message || errorBody.message || `Errore API ${response.status}`);
                err.status = errorBody.error?.status || response.status;
                err.response = { data: errorBody };
                throw err;
            }
            if (response.status === 204 || response.headers.get('content-length') === '0') {
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error(`Catch in _makeApiRequest per ${method} ${endpoint}:`, error.message);
            throw error;
        }
    }

    async getUserProfile(sessionId) {
        if (!sessionId) throw new Error('SessionId richiesto per getUserProfile');
        const userTokens = await this.getUserTokens(sessionId);
        if (!userTokens || !userTokens.access_token) {
            throw { status: 401, message: 'Utente non autenticato o token mancante/scaduto per getUserProfile.', response: { data: { error: { status: 401, message: 'Token non valido'}} }};
        }
        return this._makeApiRequest(sessionId, '/me');
    }

    async getUserPlaylists(sessionId, options = { limit: 20, offset: 0 }) {
        if (!sessionId) throw new Error('SessionId richiesto per getUserPlaylists');
        const userTokens = await this.getUserTokens(sessionId);
        if (!userTokens || !userTokens.access_token) {
             throw { status: 401, message: 'Utente non autenticato o token mancante/scaduto per getUserPlaylists.', response: { data: { error: { status: 401, message: 'Token non valido'}} }};
        }
        const params = new URLSearchParams(options).toString();
        const data = await this._makeApiRequest(sessionId, `/me/playlists?${params}`);
        return data.items.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            imageUrl: p.images[0]?.url,
            owner: p.owner.display_name,
            tracksCount: p.tracks.total,
            public: p.public,
            collaborative: p.collaborative,
            external_url: p.external_urls.spotify
        }));
    }

    async getFeaturedPlaylists(sessionId, options = { limit: 20, offset: 0 }) {
        const cacheKey = `cache:featured-playlists:limit=${options.limit}:offset=${options.offset}`;
        const fetcher = async () => {
            const params = new URLSearchParams(options).toString();
            const data = await this._makeApiRequest(sessionId, `/browse/featured-playlists?${params}`);
            return data.playlists.items.map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                image: p.images[0]?.url,
                spotify_id: p.id,
                type: 'playlist',
                owner: p.owner?.display_name || 'Spotify'
            }));
        };
        return this._getWithCache(cacheKey, fetcher, 3600); // Cache per 1 ora
    }

    async searchTrack(query, limit = 10) {
        try {
            const data = await this._makeApiRequest(null, `/search?q=${encodeURIComponent(query)}&type=track&market=IT&limit=${limit}`);
            
            if (!data.tracks || data.tracks.items.length === 0) {
                return { success: false, message: "Nessun risultato trovato" };
            }

            const groupedTracks = new Map();
            data.tracks.items.forEach(track => {
                const trackNameLower = track.name.toLowerCase();
                const firstArtistNameLower = track.artists.length > 0 ? track.artists[0].name.toLowerCase() : '';
                const groupKey = `${trackNameLower}|${firstArtistNameLower}`;

                if (!groupedTracks.has(groupKey)) {
                    groupedTracks.set(groupKey, []);
                }
                groupedTracks.get(groupKey).push(track);
            });

            const finalTracks = [];
            for (const trackGroup of groupedTracks.values()) {
                let representativeTrack = trackGroup[0];

                if (trackGroup.length > 1) {
                    const durations = trackGroup.map(t => t.duration_ms).sort((a, b) => a - b);
                    let medianDuration;
                    const mid = Math.floor(durations.length / 2);
                    if (durations.length % 2 === 0) {
                        medianDuration = (durations[mid - 1] + durations[mid]) / 2;
                    } else {
                        medianDuration = durations[mid];
                    }

                    let minDiff = Infinity;
                    trackGroup.forEach(track => {
                        const diff = Math.abs(track.duration_ms - medianDuration);
                        if (diff < minDiff) {
                            minDiff = diff;
                            representativeTrack = track;
                        }
                    });
                }
                
                finalTracks.push({
                    name: representativeTrack.name,
                    artist: representativeTrack.artists.map(artist => artist.name).join(', '),
                    album: representativeTrack.album.name,
                    image: representativeTrack.album.images[0]?.url || null,
                    duration: representativeTrack.duration_ms,
                    spotify_id: representativeTrack.id
                });
            }

            return {
                success: true,
                tracks: finalTracks
            };

        } catch (error) {
            console.error('Errore nella ricerca traccia (SpotifyAPI):', error.message, error.status);
            return { 
                success: false, 
                message: error.message || "Errore durante la ricerca tracce",
                error: { message: error.message, status: error.status }
            };
        }
    }

    // Nuovo metodo per ricerca multi-tipo con ordinamento per pertinenza
    async searchMultiType(query, limit = 10) {
        try {
            const searchLimit = Math.min(limit, 50); // Spotify limita a 50 per tipo
            
            // Ricerca tutti i tipi in una sola chiamata
            const data = await this._makeApiRequest(
                null, 
                `/search?q=${encodeURIComponent(query)}&type=track,artist,album,playlist&market=IT&limit=${searchLimit}`
            );
            
            const queryLower = query.toLowerCase().trim();
            const results = {
                tracks: [],
                artists: [],
                albums: [],
                playlists: []
            };

            // Funzione per calcolare la pertinenza
            const calculateRelevance = (name, type) => {
                const nameLower = name.toLowerCase();
                let score = 0;
                
                // Corrispondenza esatta = massima priorità
                if (nameLower === queryLower) {
                    score += 1000;
                }
                // Inizia con la query
                else if (nameLower.startsWith(queryLower)) {
                    score += 100;
                }
                // Contiene la query
                else if (nameLower.includes(queryLower)) {
                    score += 50;
                }
                // Ogni parola che corrisponde
                const queryWords = queryLower.split(' ').filter(word => word.length > 0);
                const nameWords = nameLower.split(' ').filter(word => word.length > 0);
                
                queryWords.forEach(queryWord => {
                    nameWords.forEach(nameWord => {
                        if (nameWord === queryWord) {
                            score += 25;
                        } else if (nameWord.includes(queryWord) || queryWord.includes(nameWord)) {
                            score += 10;
                        }
                    });
                });

                // Bonus per tipo (tracce hanno priorità)
                if (type === 'track') score += 5;
                else if (type === 'artist') score += 3;
                else if (type === 'album') score += 2;
                else if (type === 'playlist') score += 1;

                return score;
            };

            // Processa le tracce con deduplicazione migliorata
            if (data.tracks && data.tracks.items) {
                const groupedTracks = new Map();
                
                data.tracks.items.forEach(track => {
                    const trackKey = `${track.name.toLowerCase()}|${track.artists[0]?.name.toLowerCase() || ''}`;
                    
                    if (!groupedTracks.has(trackKey)) {
                        groupedTracks.set(trackKey, []);
                    }
                    groupedTracks.get(trackKey).push(track);
                });

                for (const trackGroup of groupedTracks.values()) {
                    let bestTrack = trackGroup[0];
                    
                    if (trackGroup.length > 1) {
                        // Scegli la versione con maggiore popolarità o durata più standard
                        bestTrack = trackGroup.reduce((prev, current) => {
                            if (current.popularity > prev.popularity) return current;
                            if (current.popularity === prev.popularity && 
                                Math.abs(current.duration_ms - 210000) < Math.abs(prev.duration_ms - 210000)) {
                                return current;
                            }
                            return prev;
                        });
                    }

                    const relevanceScore = calculateRelevance(bestTrack.name, 'track') + 
                                         calculateRelevance(bestTrack.artists[0]?.name || '', 'artist') * 0.5;

                    results.tracks.push({
                        type: 'track',
                        name: bestTrack.name,
                        artist: bestTrack.artists.map(artist => artist.name).join(', '),
                        album: bestTrack.album.name,
                        image: bestTrack.album.images[0]?.url || null,
                        duration: bestTrack.duration_ms,
                        spotify_id: bestTrack.id,
                        relevance: relevanceScore,
                        popularity: bestTrack.popularity || 0
                    });
                }
            }

            // Processa gli artisti
            if (data.artists && data.artists.items) {
                data.artists.items.forEach(artist => {
                    const relevanceScore = calculateRelevance(artist.name, 'artist');
                    
                    results.artists.push({
                        type: 'artist',
                        name: artist.name,
                        image: artist.images[0]?.url || null,
                        spotify_id: artist.id,
                        genres: artist.genres || [],
                        followers: artist.followers?.total || 0,
                        popularity: artist.popularity || 0,
                        relevance: relevanceScore
                    });
                });
            }

            // Processa gli album
            if (data.albums && data.albums.items) {
                data.albums.items.forEach(album => {
                    const relevanceScore = calculateRelevance(album.name, 'album') + 
                                         calculateRelevance(album.artists[0]?.name || '', 'artist') * 0.3;
                    
                    results.albums.push({
                        type: 'album',
                        name: album.name,
                        artist: album.artists.map(artist => artist.name).join(', '),
                        image: album.images[0]?.url || null,
                        spotify_id: album.id,
                        release_date: album.release_date || null,
                        total_tracks: album.total_tracks || 0,
                        relevance: relevanceScore
                    });
                });
            }

            // Processa le playlist
            if (data.playlists && data.playlists.items) {
                data.playlists.items.forEach(playlist => {
                    const relevanceScore = calculateRelevance(playlist.name, 'playlist') + 
                                         calculateRelevance(playlist.description || '', 'playlist') * 0.2;
                    
                    results.playlists.push({
                        type: 'playlist',
                        name: playlist.name,
                        description: playlist.description || '',
                        image: playlist.images[0]?.url || null,
                        spotify_id: playlist.id,
                        owner: playlist.owner?.display_name || 'Unknown',
                        tracks_total: playlist.tracks?.total || 0,
                        relevance: relevanceScore
                    });
                });
            }

            // Ordina ogni categoria per pertinenza e popolarità
            Object.keys(results).forEach(key => {
                results[key].sort((a, b) => {
                    // Prima per pertinenza
                    if (b.relevance !== a.relevance) {
                        return b.relevance - a.relevance;
                    }
                    // Poi per popolarità se disponibile
                    if (a.popularity !== undefined && b.popularity !== undefined) {
                        return b.popularity - a.popularity;
                    }
                    // Infine per followers (artisti)
                    if (a.followers !== undefined && b.followers !== undefined) {
                        return b.followers - a.followers;
                    }
                    return 0;
                });
            });

            // Crea l'array finale ordinato con i migliori risultati di ogni categoria
            const allResults = [];
            
            // Aggiungi i migliori di ogni categoria alternando per varietà
            const maxPerCategory = Math.ceil(limit / 4);
            
            for (let i = 0; i < maxPerCategory; i++) {
                if (results.tracks[i]) allResults.push(results.tracks[i]);
                if (results.artists[i]) allResults.push(results.artists[i]);
                if (results.albums[i]) allResults.push(results.albums[i]);
                if (results.playlists[i]) allResults.push(results.playlists[i]);
            }

            // Ordina il risultato finale per pertinenza globale
            allResults.sort((a, b) => b.relevance - a.relevance);

            return {
                success: true,
                results: allResults.slice(0, limit),
                by_type: results,
                total_found: {
                    tracks: data.tracks?.total || 0,
                    artists: data.artists?.total || 0,
                    albums: data.albums?.total || 0,
                    playlists: data.playlists?.total || 0
                }
            };

        } catch (error) {
            console.error('Errore nella ricerca multi-tipo (SpotifyAPI):', error.message, error.status);
            return { 
                success: false, 
                message: error.message || "Errore durante la ricerca multi-tipo",
                error: { message: error.message, status: error.status }
            };
        }
    }

    async getUserTopArtists(sessionId, options = { limit: 10, time_range: 'medium_term' }) {
        if (!sessionId) throw new Error('SessionId richiesto per getUserTopArtists');
        
        // La cache per i dati utente deve essere specifica per l'utente
        const user = await this.getUserProfile(sessionId);
        if(!user || !user.id) throw new Error('Impossibile ottenere il profilo utente per la chiave di cache.');

        const cacheKey = `cache:user:${user.id}:top-artists:limit=${options.limit}:range=${options.time_range}`;
        
        const fetcher = async () => {
            const userTokens = await this.getUserTokens(sessionId);
            if (!userTokens || !userTokens.access_token) {
                throw { status: 401, message: 'Utente non autenticato o token mancante/scaduto per getUserTopArtists.', response: { data: { error: { status: 401, message: 'Token non valido'}} }};
            }
            const params = new URLSearchParams(options).toString();
            const data = await this._makeApiRequest(sessionId, `/me/top/artists?${params}`);
            return data.items.map(artist => ({
                id: artist.id,
                name: artist.name,
                images: artist.images,
                genres: artist.genres,
                popularity: artist.popularity,
                followers: artist.followers.total,
                external_url: artist.external_urls.spotify
            }));
        };

        return this._getWithCache(cacheKey, fetcher, 6 * 3600); // Cache per 6 ore
    }

    async getUserSavedTracks(sessionId, options = { limit: 20, offset: 0 }) {
        if (!sessionId) throw new Error('SessionId richiesto per getUserSavedTracks');
        // NOTA: Le tracce salvate cambiano spesso, la cache qui dovrebbe essere molto breve o invalidata aggressivamente.
        // Per ora, non la implementiamo per evitare dati stantii.
        const userTokens = await this.getUserTokens(sessionId);
        if (!userTokens || !userTokens.access_token) {
            throw { status: 401, message: 'Utente non autenticato o token mancante/scaduto per getUserSavedTracks.', response: { data: { error: { status: 401, message: 'Token non valido'}} }};
        }
        const params = new URLSearchParams(options).toString();
        const data = await this._makeApiRequest(sessionId, `/me/tracks?${params}`);
        return {
            items: data.items.map(item => ({
                added_at: item.added_at,
                track: {
                    id: item.track.id,
                    name: item.track.name,
                    artists: item.track.artists,
                    album: item.track.album,
                    duration_ms: item.track.duration_ms,
                    preview_url: item.track.preview_url,
                    external_url: item.track.external_urls.spotify
                }
            })),
            total: data.total,
            limit: data.limit,
            offset: data.offset
        };
    }

    // Nuovo metodo per ottenere dettagli artista
    async getArtistDetails(artistId) {
        const cacheKey = `cache:artist-details:${artistId}`;
        const fetcher = async () => {
            const [artistData, topTracksData, albumsData] = await Promise.all([
                this._makeApiRequest(null, `/artists/${artistId}`),
                this._makeApiRequest(null, `/artists/${artistId}/top-tracks?market=IT`),
                this._makeApiRequest(null, `/artists/${artistId}/albums?market=IT&limit=20&include_groups=album,single`)
            ]);

            return {
                artist: {
                    id: artistData.id,
                    name: artistData.name,
                    image: artistData.images[0]?.url || null,
                    followers: artistData.followers?.total || 0,
                    popularity: artistData.popularity || 0,
                    genres: artistData.genres || [],
                    external_url: artistData.external_urls?.spotify || null
                },
                topTracks: topTracksData.tracks.map(track => ({
                    type: 'track',
                    name: track.name,
                    artist: track.artists.map(artist => artist.name).join(', '),
                    album: track.album.name,
                    image: track.album.images[0]?.url || null,
                    duration: track.duration_ms,
                    spotify_id: track.id,
                    popularity: track.popularity || 0,
                    preview_url: track.preview_url
                })).slice(0, 10), // Limita alle prime 10 tracce più popolari
                albums: albumsData.items.map(album => ({
                    type: 'album',
                    id: album.id,
                    name: album.name,
                    artist: album.artists.map(a => a.name).join(', '),
                    image: album.images[0]?.url || null,
                    release_date: album.release_date,
                    total_tracks: album.total_tracks,
                    spotify_id: album.id,
                    album_type: album.album_type,
                    external_url: album.external_urls?.spotify || null
                }))
            };
        };

        try {
            const data = await this._getWithCache(cacheKey, fetcher, 12 * 3600); // Cache per 12 ore
            return { success: true, ...data };
        } catch (error) {
            console.error('Errore nel recupero dettagli artista:', error.message);
            return { 
                success: false, 
                message: error.message || "Errore durante il recupero dei dettagli dell'artista",
                error: { message: error.message, status: error.status }
            };
        }
    }

    // Nuovo metodo per ottenere dettagli album
    async getAlbumDetails(albumId) {
        const cacheKey = `cache:album-details:${albumId}`;
        const fetcher = async () => {
            const [albumData, tracksData] = await Promise.all([
                this._makeApiRequest(null, `/albums/${albumId}`),
                this._makeApiRequest(null, `/albums/${albumId}/tracks?market=IT&limit=50`)
            ]);

            return {
                album: {
                    id: albumData.id,
                    name: albumData.name,
                    artist: albumData.artists.map(artist => artist.name).join(', '),
                    image: albumData.images[0]?.url || null,
                    release_date: albumData.release_date,
                    total_tracks: albumData.total_tracks,
                    genres: albumData.genres || [],
                    popularity: albumData.popularity || 0,
                    type: albumData.album_type,
                    external_url: albumData.external_urls?.spotify || null,
                    label: albumData.label,
                    copyright: albumData.copyrights?.[0]?.text || null
                },
                tracks: tracksData.items.map((track, index) => ({
                    type: 'track',
                    track_number: track.track_number || index + 1,
                    name: track.name,
                    artist: track.artists.map(artist => artist.name).join(', '),
                    duration: track.duration_ms,
                    spotify_id: track.id,
                    preview_url: track.preview_url,
                    explicit: track.explicit || false,
                    // Aggiungi info album per compatibilità con player
                    album: albumData.name,
                    image: albumData.images[0]?.url || null
                }))
            };
        };
        
        try {
            const data = await this._getWithCache(cacheKey, fetcher, 24 * 3600); // Cache per 24 ore
            return { success: true, ...data };
        } catch (error) {
            console.error('Errore nel recupero dettagli album:', error.message);
            return { 
                success: false, 
                message: error.message || "Errore durante il recupero dei dettagli dell'album",
                error: { message: error.message, status: error.status }
            };
        }
    }

    // Nuovo metodo per ottenere tracce di una playlist
    async getPlaylistTracks(playlistId, limit = 50, offset = 0) {
        const cacheKey = `cache:playlist-tracks:${playlistId}:limit=${limit}:offset=${offset}`;

        const fetcher = async () => {
             const params = new URLSearchParams({
                market: 'IT',
                limit: limit.toString(),
                offset: offset.toString(),
                fields: 'items(track(id,name,artists,album(name,images),duration_ms,preview_url,explicit)),total,limit,offset,next,previous'
            }).toString();

            const data = await this._makeApiRequest(null, `/playlists/${playlistId}/tracks?${params}`);

            return {
                items: data.items.map(item => ({
                    track: item.track ? {
                        type: 'track',
                        spotify_id: item.track.id,
                        name: item.track.name,
                        artist: item.track.artists.map(artist => artist.name).join(', '),
                        album: item.track.album.name,
                        image: item.track.album.images[0]?.url || null,
                        duration: item.track.duration_ms,
                        preview_url: item.track.preview_url,
                        explicit: item.track.explicit || false
                    } : null
                })).filter(item => item.track !== null), // Rimuovi tracce nulle (locali o non disponibili)
                total: data.total,
                limit: data.limit,
                offset: data.offset,
                next: data.next,
                previous: data.previous
            };
        };
        
        try {
            const data = await this._getWithCache(cacheKey, fetcher, 3600); // Cache per 1 ora
            return { success: true, ...data };
        } catch (error) {
            console.error('Errore nel recupero tracce playlist:', error.message);
            return { 
                success: false, 
                message: error.message || "Errore durante il recupero delle tracce della playlist",
                error: { message: error.message, status: error.status }
            };
        }
    }

    // Nuovo metodo per ottenere raccomandazioni
    async getRecommendations(options = {}) {
        // Le raccomandazioni sono dinamiche, quindi è meglio non cacharle
        try {
            const params = new URLSearchParams({
                market: 'IT',
                limit: (options.limit || 20).toString(),
                ...options
            }).toString();

            const data = await this._makeApiRequest(null, `/recommendations?${params}`);

            return {
                success: true,
                tracks: data.tracks.map(track => ({
                    spotify_id: track.id,
                    name: track.name,
                    artist: track.artists.map(artist => artist.name).join(', '),
                    album: track.album.name,
                    image: track.album.images[0]?.url || null,
                    duration: track.duration_ms,
                    preview_url: track.preview_url,
                    popularity: track.popularity || 0
                }))
            };

        } catch (error) {
            console.error('Errore nel recupero raccomandazioni:', error.message);
            return { 
                success: false, 
                message: error.message || "Errore durante il recupero delle raccomandazioni",
                error: { message: error.message, status: error.status }
            };
        }
    }
}

// // Test della classe
// (async () => {
//     const spotifyAPI = new SpotifyAPI();
//     await spotifyAPI.getAccessToken();
//     console.log('Stato della classe:', {
//         token: spotifyAPI.token,
//         expirationTime: spotifyAPI.tokenExpirationTime
//     });
// })();

// // Esempio di utilizzo
// (async () => {
//     const spotifyAPI = new SpotifyAPI();
//     await spotifyAPI.getAccessToken();
    
//     const result = await spotifyAPI.searchTrack("gimme more Britney Spears");
//     if (result.success) {
//         console.log("Risultato della ricerca:");
//         console.log(JSON.stringify(result.data, null, 2));
//     }
// })();
