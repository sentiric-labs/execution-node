const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');

// Klasör Yolları
const TEMP_DIR = path.join(__dirname, 'temp');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TIMELINE_PATH = path.join(__dirname, 'timeline.json');
const LIST_FILE = path.join(TEMP_DIR, 'list.txt');

// --- 1. YARDIMCI FONKSİYONLAR ---

// Pollinations.ai'den Resim İndirme
async function downloadImage(prompt, filepath) {
    console.log(`🖼️ [VISUAL] Resim üretiliyor: "${prompt.substring(0, 30)}..."`);
    const encodedPrompt = encodeURIComponent(prompt);
    // 1920x1080 çözünürlük, logo kapalı
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true`;
    
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Edge-TTS ile Ses Sentezleme (Node API veya CLI Fallback)
// Orijinal Python Edge-TTS CLI ile Ses Sentezleme
async function generateAudio(text, filepath) {
    console.log(`🔊 [AUDIO] Ses sentezleniyor: "${text.substring(0, 30)}..."`);
    return new Promise((resolve, reject) => {
        // 'npx edge-tts' yerine doğrudan 'edge-tts' komutunu kullanıyoruz.
        // Eğer komut bulunamazsa yola ~/.local/bin/edge-tts eklenebilir.
        const command = `edge-tts --text "${text}" --voice "tr-TR-AhmetNeural" --write-media "${filepath}"`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`🚨 Ses sentezleme hatası: ${stderr || error.message}`);
                reject(error);
                return;
            }
            resolve();
        });
    });
}

// Sahneyi (Resim + Ses) MP4'e Çevirme
async function createSceneVideo(imagePath, audioPath, outputPath) {
    console.log(`🎬 [RENDER] Sahne birleştiriliyor: ${path.basename(outputPath)}`);
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(imagePath)
            .inputOptions([
                '-loop 1',         // Resmi sonsuz bir video gibi oynat
                '-framerate 30'    // 30 FPS (YouTube Standardı)
            ])
            .input(audioPath)
            .outputOptions([
                '-c:v libx264',
                '-tune stillimage',
                '-c:a aac',
                '-b:a 192k',
                '-pix_fmt yuv420p',
                '-shortest'        // Sesin bittiği salise videoyu kes (Çok Kritik!)
            ])
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject);
    });
}

// Tüm Sahneleri Uç Uca Ekleme (Concat)
async function concatScenes(sceneFiles, finalOutput) {
    console.log(`📦 [ASSEMBLY] Sahneler birleştiriliyor (Stitching)...`);
    
    // FFmpeg için list.txt oluştur
    const listContent = sceneFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(LIST_FILE, listContent);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(LIST_FILE)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions('-c copy') // Yeniden renderlamadan saniyeler içinde kopyala!
            .save(finalOutput)
            .on('end', resolve)
            .on('error', reject);
    });
}

// --- 2. ANA ORKESTRASYON DÖNGÜSÜ (THE MUSCLE) ---

async function runExecutionNode() {
    console.log("🚀 [SENTIRIC LABS] Execution Node (Kas Sistemi) Başlatıldı...\n");

    try {
        // 1. Timeline'ı Oku
        if (!fs.existsSync(TIMELINE_PATH)) throw new Error("timeline.json bulunamadı!");
        const rawData = fs.readFileSync(TIMELINE_PATH, 'utf-8');
        const projectData = JSON.parse(rawData);
        const timeline = projectData.timeline;
        
        console.log(`📑 Toplam ${timeline.length} sahne algılandı. Üretim başlıyor...\n`);

        const sceneVideos =[];

        // 2. Her sahne için paralel olmayan (senkron) üretim
        for (let i = 0; i < timeline.length; i++) {
            const scene = timeline[i];
            const imgPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.jpg`);
            const audioPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.mp3`);
            const videoPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.mp4`);

            // A. Görseli İndir
            await downloadImage(scene.visual_prompt, imgPath);
            
            // B. Sesi Üret
            await generateAudio(scene.voiceover_text, audioPath);
            
            // C. MP4 Yap
            await createSceneVideo(imgPath, audioPath, videoPath);
            
            sceneVideos.push(videoPath);
            console.log(`✅ Sahne ${scene.scene_id} Tamamlandı!\n`);
        }

        // 3. Videoları Birleştir
        const finalOutput = path.join(OUTPUT_DIR, `WL_FINAL_${Date.now()}.mp4`);
        await concatScenes(sceneVideos, finalOutput);

        console.log(`🎉[BAŞARILI] Karanlık Fabrika ilk otonom videoyu üretti!`);
        console.log(`📂 Dosya Yolu: ${finalOutput}\n`);

    } catch (error) {
        console.error("🚨[SİSTEM ÇÖKTÜ]:", error);
    }
}

// Motoru Ateşle
runExecutionNode();