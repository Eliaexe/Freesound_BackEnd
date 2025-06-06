import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import util from 'util';

// Fix per __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execPromise = util.promisify(exec);

export default class YoutubeAPI {
    constructor() {
        // La directory downloads è ora gestita da index.js, ma la manteniamo per sanitizeFilename se necessario
        // this.downloadsDir = path.join(__dirname, '..', 'downloads'); 
        // this.ensureDownloadsDir();
    }

    // ensureDownloadsDir() { // Non più strettamente necessario qui se index.js la crea
    //     if (!fs.existsSync(this.downloadsDir)) {
    //         fs.mkdirSync(this.downloadsDir, { recursive: true });
    //     }
    // }

    /**
     * Cerca tra i primi N video su YouTube, seleziona il migliore in base alla durata e lo scarica.
     * @param {string} query - Query di ricerca (titolo + artista)
     * @param {number} targetDurationMs - Durata target in millisecondi
     * @param {string} outputPath - Percorso completo dove salvare il file MP3
     * @returns {Promise<{success: boolean, path?: string, duration?: number, message?: string, metadata?: any}>}
     */
    async searchAndDownload(query, targetDurationMs, outputPath) {
        const sanitizedQueryForSearch = query.replace(/["']/g, '');
        
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`📂 Creata directory: ${outputDir}`);
        }

        const NUM_VIDEOS_TO_SEARCH = 3;
        const searchCommand = `yt-dlp "ytsearch${NUM_VIDEOS_TO_SEARCH}:${sanitizedQueryForSearch}" --dump-json --no-warnings --ignore-errors`;
        console.log(`🔍 Comando ricerca metadati yt-dlp: ${searchCommand}`);

        let searchStdout, searchStderr;
        try {
            const { stdout, stderr } = await execPromise(searchCommand);
            searchStdout = stdout;
            searchStderr = stderr;
            if (searchStderr) {
                console.warn(`Stderr ricerca yt-dlp (non fatale o gestito da --ignore-errors): ${searchStderr.trim()}`);
            }
        } catch (error) {
            console.error(`❌ Errore durante l'esecuzione della ricerca metadati yt-dlp per "${query}":`, error.message);
            if (error.stderr) console.error(`Stderr ricerca yt-dlp: ${error.stderr.trim()}`);
            
            searchStdout = error.stdout || "";
            if (!searchStdout.trim() && !(error.stdout && error.stdout.trim())) {
                throw { success: false, message: `Errore yt-dlp fatale durante ricerca metadati: ${error.message}`, error };
            }
            console.warn("Ricerca metadati yt-dlp ha prodotto un errore, ma si tenta di procedere con stdout parziale (o vuoto) se presente.");
        }
        
        const videoMetadatas = searchStdout.trim().split('\n')
            .map(line => {
                if (!line.trim()) return null;
                try {
                    return JSON.parse(line);
                } catch (e) {
                    console.warn(`⚠️ Impossibile parsare riga JSON metadati: "${line.substring(0, 100)}..."`, e.message);
                    return null;
                }
            })
            .filter(video => video && video.webpage_url && typeof video.duration === 'number');

        if (videoMetadatas.length === 0) {
            console.log(`🚫 Nessun video valido (con URL e durata) trovato nella ricerca metadati per "${query}".`);
            throw { success: false, message: 'Nessun video valido trovato nella ricerca iniziale su YouTube.' };
        }

        console.log(`ℹ️ Trovati ${videoMetadatas.length} potenziali video con metadati validi.`);
        videoMetadatas.forEach((v, i) => console.log(`  ${i+1}. Titolo: ${v.title}, Durata: ${v.duration}s, URL: ${v.webpage_url?.substring(0,30)}...`));

        let selectedVideoUrl = null;
        let selectedVideoMetadata = null;

        if (targetDurationMs) {
            const targetSeconds = targetDurationMs / 1000;
            const tolerance = Math.max(5, Math.min(15, targetSeconds * 0.10)); 
            const minDuration = targetSeconds - tolerance;
            const maxDuration = targetSeconds + tolerance;
            console.log(`🎯 Filtro durata target: ${minDuration.toFixed(2)}s - ${maxDuration.toFixed(2)}s (Target: ${targetSeconds.toFixed(2)}s)`);

            for (const video of videoMetadatas) {
                if (video.duration >= minDuration && video.duration <= maxDuration) {
                    selectedVideoUrl = video.webpage_url;
                    selectedVideoMetadata = video;
                    console.log(`✅ Video selezionato: "${video.title}" (Durata: ${video.duration}s) URL: ${selectedVideoUrl}`);
                    break; 
                } else {
                    console.log(`➖ Video scartato: "${video.title}" (Durata: ${video.duration}s non rientra nel range)`);
                }
            }

            if (!selectedVideoUrl) {
                console.log(`⚠️ Nessun video trovato nei primi ${videoMetadatas.length} risultati che corrisponde al filtro di durata.`);
                throw { success: false, message: `Nessun video trovato tra i primi ${videoMetadatas.length} risultati che soddisfa il criterio di durata.` };
            }
        } else {
            selectedVideoUrl = videoMetadatas[0]?.webpage_url;
            selectedVideoMetadata = videoMetadatas[0];
             if(selectedVideoUrl) {
                 console.log(`✅ Video selezionato (nessun filtro durata): "${selectedVideoMetadata.title}" URL: ${selectedVideoUrl}`);
            } else {
                 console.log(`🚫 Nessun video valido trovato (e nessun filtro durata).`);
                 throw { success: false, message: 'Nessun video valido trovato nella ricerca (e nessun filtro durata).' };
            }
        }
        
        const downloadCommand = `yt-dlp "${selectedVideoUrl}" ` +
            `-f "bestaudio[ext=m4a]/bestaudio" -x --audio-format mp3 --audio-quality 0 ` +
            `--parse-metadata "%(release_date,upload_date)s:%(meta_date)s" --parse-metadata "%(title)s:%(meta_title)s" ` +
            `-o "${outputPath.replace(/"/g, '\\"')}" --no-progress --quiet`;

        console.log(`⚙️ Comando download yt-dlp: ${downloadCommand.replace(selectedVideoUrl, selectedVideoUrl.substring(0,40) + "...")}`);

        try {
            const { stdout: downloadStdout, stderr: downloadStderr } = await execPromise(downloadCommand);
            if (downloadStderr) {
                console.warn(`Stderr download yt-dlp (non fatale, --quiet attivo): ${downloadStderr.trim()}`);
            }
        } catch (downloadError) {
            console.error(`❌ Errore durante l'esecuzione del download di yt-dlp per "${selectedVideoUrl}":`, downloadError.message);
            if (downloadError.stderr) console.error(`Stderr yt-dlp (download): ${downloadError.stderr.trim()}`);
            
            if (fs.existsSync(outputPath)) {
                console.warn(`⚠️ yt-dlp ha segnalato un errore durante il download, ma il file di output ${outputPath} esiste. Procedo considerandolo un successo.`);
                 return { 
                    success: true, 
                    path: outputPath, 
                    duration: selectedVideoMetadata?.duration ? selectedVideoMetadata.duration * 1000 : undefined,
                    metadata: selectedVideoMetadata ? {
                        title: selectedVideoMetadata.title || 'N/D',
                        channel: selectedVideoMetadata.uploader || 'N/D',
                        url: selectedVideoMetadata.webpage_url
                    } : undefined
                };
            }
            throw { success: false, message: `Errore yt-dlp durante download e file di output non trovato: ${downloadError.message}`, error: downloadError };
        }
        
        if (fs.existsSync(outputPath)) {
            console.log(`✅ File scaricato con successo: ${outputPath}`);
            return {
                success: true,
                path: outputPath,
                duration: selectedVideoMetadata?.duration ? selectedVideoMetadata.duration * 1000 : undefined,
                metadata: selectedVideoMetadata ? {
                    title: selectedVideoMetadata.title || 'N/D',
                    channel: selectedVideoMetadata.uploader || 'N/D',
                    url: selectedVideoMetadata.webpage_url,
                } : undefined
            };
        } else {
            console.error(`❌ File non trovato a ${outputPath} dopo tentativo di download del video selezionato (yt-dlp non ha dato errori critici o il workaround non si è attivato).`);
            throw { success: false, message: 'File non trovato dopo download del video selezionato (yt-dlp non ha lanciato eccezioni o il file non è stato creato).' };
        }
    }
}