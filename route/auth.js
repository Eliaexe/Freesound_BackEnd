import express from 'express';
import crypto from 'crypto';

// Questa funzione crea e ritorna il router per l'autenticazione.
// Accetta spotifyAPI come dipendenza per interagire con Spotify.
export default function createAuthRouter(spotifyAPI) {
    const router = express.Router();

    router.get('/login', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        req.session.spotify_auth_state = state;

        const level = req.query.level || 'basic';
        const scopes = {
            basic: [
                'user-read-private', 'user-read-email', 'user-library-read', 
                'user-top-read', 'playlist-read-private', 'playlist-read-collaborative'
            ],
            crud: [
                'playlist-modify-public', 'playlist-modify-private', 'user-library-modify'
            ]
        };
        const scope = (level === 'crud')
            ? [...new Set([...scopes.basic, ...scopes.crud])].join(' ')
            : scopes.basic.join(' ');
        
        const authUrl = 'https://accounts.spotify.com/authorize?' +
            new URLSearchParams({
                response_type: 'code',
                client_id: process.env.SPOTIFY_CLIENT_ID,
                scope: scope,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
                state: state
            }).toString();
        
        res.redirect(authUrl);
    });

    router.post('/exchange', async (req, res) => {
        const { code, state } = req.body;
        const storedState = req.session.spotify_auth_state;

        if (!code || !state || state !== storedState) {
            return res.status(400).json({ error: 'State mismatch o codice mancante.' });
        }
        delete req.session.spotify_auth_state;

        try {
            const tokenData = await spotifyAPI.exchangeCodeForTokens(code);
            await spotifyAPI.setUserTokens(req.session, tokenData);
            const userProfile = await spotifyAPI.getUserProfile(req.session);
            
            console.log(`Login completato per: ${userProfile.display_name}`);
            res.json({ success: true, user: userProfile });
        } catch (error) {
            console.error('Errore in /auth/exchange:', error.message);
            res.status(500).json({ error: 'Autenticazione fallita.' });
        }
    });

    router.post('/logout', (req, res) => {
        if (req.session) {
            req.session.destroy((err) => {
                if (err) {
                    console.error("Errore durante la distruzione della sessione:", err);
                    return res.status(500).json({ message: 'Logout non riuscito.' });
                }
                res.clearCookie('connect.sid');
                res.status(204).send();
            });
        } else {
            res.status(204).send();
        }
    });

    router.get('/status', (req, res) => {
        // Un utente è considerato autenticato se la sessione contiene i token.
        if (req.session && req.session.tokens) {
            res.json({ isAuthenticated: true });
        } else {
            res.json({ isAuthenticated: false });
        }
    });

    return router;
} 