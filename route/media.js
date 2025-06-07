import express from 'express';
import path from 'path';
import fs from 'fs';

// Crea e ritorna il router per le funzionalità media (ricerca, stream).
// Accetta le dipendenze spotifyAPI, youtubeAPI e la directory dei download.
export default function createMediaRouter(spotifyAPI, youtubeAPI, downloadsDir) {
    const router = express.Router();

    router.post('/search', async (req, res) => {
        try {
            const { query } = req.body;
            if (!query || typeof query !== 'string') {
                return res.status(400).json({ error: 'Query non valida.' });
            }
            const searchResult = await spotifyAPI.searchMultiType(query, 20);
            res.json(searchResult);
        } catch (error) {
            console.error('Errore /search:', error);
            res.status(500).json({ error: 'Errore durante la ricerca.' });
        }
    });

    router.get('/stream/:spotify_id', async (req, res) => {
        try {
            const { spotify_id } = req.params;
            const { title, artist, duration_ms } = req.query;

            if (!spotify_id || !title || !artist || !duration_ms) {
                return res.status(400).send('Parametri mancanti.');
            }

            const parsedDurationMs = parseInt(duration_ms, 10);
            let fileName = `${artist} - ${title}.mp3`.replace(/[^a-zA-Z0-9\s\-\.]/g, '').trim();
            const filePath = path.join(downloadsDir, fileName);

            if (fs.existsSync(filePath)) {
                console.log(`Streaming dalla cache: ${fileName}`);
                const stream = fs.createReadStream(filePath);
                res.set({'Content-Type': 'audio/mpeg'});
                stream.pipe(res);
            } else {
                console.log(`Download da YouTube per: ${fileName}`);
                const youtubeResult = await youtubeAPI.searchAndDownload(
                    `${artist} ${title}`,
                    parsedDurationMs,
                    filePath
                );
                
                if (youtubeResult.success) {
                    const stream = fs.createReadStream(youtubeResult.path);
                    res.set({'Content-Type': 'audio/mpeg'});
                    stream.pipe(res);
                } else {
                    res.status(404).send(youtubeResult.message || 'Canzone non trovata su YouTube.');
                }
            }
        } catch (error) {
            console.error(`Errore /stream/${req.params.spotify_id}:`, error);
            if (!res.headersSent) {
                res.status(500).send('Errore durante lo streaming.');
            }
        }
    });

    return router;
} 