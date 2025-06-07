import express from 'express';

// Crea e ritorna il router per le API di Spotify.
// Richiede spotifyAPI per effettuare le chiamate.
export default function createSpotifyApiRouter(spotifyAPI) {
    const router = express.Router();

    // Middleware per verificare l'autenticazione per le rotte protette
    const ensureAuthenticated = (req, res, next) => {
        if (req.session && req.session.tokens) {
            return next();
        }
        res.status(401).json({ error: 'Utente non autenticato.' });
    };

    // Rotta pubblica (non richiede autenticazione utente)
    router.get('/artists/:artistId', async (req, res) => {
        try {
            const { artistId } = req.params;
            const artistDetails = await spotifyAPI.getArtistDetails(artistId);
            res.json(artistDetails);
        } catch (error) {
            res.status(500).json({ error: `Errore dettagli artista: ${error.message}` });
        }
    });
    
    router.get('/albums/:albumId', async (req, res) => {
        try {
            const { albumId } = req.params;
            const albumDetails = await spotifyAPI.getAlbumDetails(albumId);
            res.json(albumDetails);
        } catch (error) {
            res.status(500).json({ error: `Errore dettagli album: ${error.message}` });
        }
    });

    router.get('/playlists/:playlistId/tracks', async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { limit, offset } = req.query;
            const playlistTracks = await spotifyAPI.getPlaylistTracks(playlistId, limit, offset);
            res.json(playlistTracks);
        } catch (error) {
            res.status(500).json({ error: `Errore tracce playlist: ${error.message}` });
        }
    });

    router.get('/recommendations', async (req, res) => {
        try {
            const recommendations = await spotifyAPI.getRecommendations(req.query);
            res.json(recommendations);
        } catch (error) {
            res.status(500).json({ error: `Errore raccomandazioni: ${error.message}` });
        }
    });
    
    router.get('/browse/featured-playlists', async (req, res) => {
        try {
            const playlists = await spotifyAPI.getFeaturedPlaylists(req.session);
            res.json(playlists);
        } catch (error) {
            res.status(500).json({ error: `Errore playlist in primo piano: ${error.message}` });
        }
    });

    // Rotte protette
    router.get('/me', ensureAuthenticated, async (req, res) => {
        try {
            const userProfile = await spotifyAPI.getUserProfile(req.session);
            res.json(userProfile);
        } catch (error) {
            res.status(500).json({ error: `Errore profilo utente: ${error.message}` });
        }
    });

    router.get('/me/playlists', ensureAuthenticated, async (req, res) => {
        try {
            const playlists = await spotifyAPI.getUserPlaylists(req.session);
            res.json(playlists);
        } catch (error) {
            res.status(500).json({ error: `Errore playlist utente: ${error.message}` });
        }
    });

    router.get('/me/top/artists', ensureAuthenticated, async (req, res) => {
        try {
            const artists = await spotifyAPI.getUserTopArtists(req.session);
            res.json(artists);
        } catch (error) {
            res.status(500).json({ error: `Errore artisti top: ${error.message}` });
        }
    });

    router.get('/me/tracks', ensureAuthenticated, async (req, res) => {
        try {
            const tracks = await spotifyAPI.getUserSavedTracks(req.session);
            res.json(tracks);
        } catch (error) {
            res.status(500).json({ error: `Errore tracce salvate: ${error.message}` });
        }
    });
    
    // Endpoint aggregato per home page
    router.get('/home/content', (req, res) => {
        res.json({ 
            featuredPlaylists: { title: 'Playlist in primo piano', items: [] }, 
            topArtists: { title: 'Artisti del momento', items: [] } 
        });
    });

    return router;
} 