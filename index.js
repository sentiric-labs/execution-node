const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// --- DİZİN VE SERTİFİKA YOLLARI ---
const TEMP_DIR = path.join(__dirname, 'temp');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TIMELINE_PATH = path.join(__dirname, 'timeline.en.json');
const LIST_FILE = path.join(TEMP_DIR, 'list.txt');

// Sentiric Contracts ve Sertifika yolları
const PROTO_PATH = '/home/ex/sentiric/sentiric-contracts/proto/sentiric/tts/v1/omnivoice.proto';
const CERT_BASE = '/home/ex/sentiric/sentiric-certificates/certs';

// --- 1. gRPC İSTEMCİSİNİ HAZIRLA (Native & mTLS) ---
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const ttsProto = grpc.loadPackageDefinition(packageDefinition).sentiric.tts.v1;

const credentials = grpc.credentials.createSsl(
    fs.readFileSync(`${CERT_BASE}/ca.crt`),
    fs.readFileSync(`${CERT_BASE}/stream-gateway-service.key`),
    fs.readFileSync(`${CERT_BASE}/stream-gateway-service-chain.crt`)
);

const ttsClient = new ttsProto.TtsOmnivoiceService('localhost:14041', credentials);

// --- 2. YARDIMCI FONKSİYONLAR ---

// WAV Header Üretici (Sihir burada)
function createWavHeader(dataLength, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM Format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * (bitDepth / 8), 28); // Byte rate
    buffer.writeUInt16LE(numChannels * (bitDepth / 8), 32); // Block align
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);
    return buffer;
}

// Görsel Üretimi
async function downloadImage(prompt, filepath) {
    console.log(`🖼️ [VISUAL] Resim üretiliyor: "${prompt.substring(0, 30)}..."`);
    const encodedPrompt = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true`;
    
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}


// 🔥 NATIVE gRPC İLE SES SENTEZLEME (OMNIVOICE)
async function generateAudioNative(text, filepath) {
    console.log(`🔊 [AUDIO] AI Motoru Tetikleniyor: "${text.substring(0, 30)}..."`);
    
    return new Promise((resolve, reject) => {
        const request = {
            text: text,
            // language_code: "tr",
            language_code: "en", 
            voice_guidance_prompt: "M_EN_Wiliam_Louis/neutral", // neutral, angry, sad, whisper
            sample_rate: 16000 // İsteğimizi 16k yapıyoruz
        };

        const metadata = new grpc.Metadata();
        metadata.add('x-trace-id', `exec-node-${Date.now()}`);
        metadata.add('x-tenant-id', 'sentiric_demo');

        const call = ttsClient.OmnivoiceSynthesizeStream(request, metadata);
        
        let audioChunks = [];

        call.on('data', (response) => {
            if (response.audio_chunk && response.audio_chunk.length > 0) {
                audioChunks.push(response.audio_chunk);
            }
        });

        call.on('end', () => {
            const rawPcmData = Buffer.concat(audioChunks);
            // 🔥 KRİTİK DÜZELTME: 24000 yerine 16000 yazıyoruz!
            const wavHeader = createWavHeader(rawPcmData.length, 16000); 
            const finalWavData = Buffer.concat([wavHeader, rawPcmData]);
            
            fs.writeFileSync(filepath, finalWavData);
            console.log(`✅ [AUDIO] Toplam ${rawPcmData.length} byte ses verisi 16kHz WAV olarak kaydedildi.`);
            resolve();
        });

        call.on('error', (error) => {
            console.error(`🚨 [GRPC ERROR]: ${error.message}`);
            reject(error);
        });
    });
}

// 🎬 KURGU MOTORU (Hareketli Resim + WAV Birleştirme)
async function createSceneVideo(imagePath, audioPath, outputPath) {
    console.log(`🎬 [RENDER] Sahne birleştiriliyor (Ken Burns FX): ${path.basename(outputPath)}`);
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(imagePath)
            .inputOptions(['-loop 1'])
            
            .input(audioPath)
            // 🔥 DÜZELTME: Ham PCM ayarlarını sildik çünkü artık kusursuz bir .WAV dosyamız var! FFmpeg kendi okuyacak.
            
            .complexFilter([
                "[0:v]zoompan=z='min(zoom+0.0015,1.5)':d=700:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080[v]"
            ])
            .outputOptions([
                '-map [v]',        
                '-map 1:a',        
                '-c:v libx264',    
                '-c:a aac',        
                '-b:a 192k',
                '-pix_fmt yuv420p',
                '-shortest'        
            ])
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject);
    });
}

// Tüm Sahneleri Uç Uca Ekleme (Concat)
async function concatScenes(sceneFiles, finalOutput) {
    console.log(`📦 [ASSEMBLY] Sahneler renderlanmadan birleştiriliyor (Stitching)...`);
    const listContent = sceneFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(LIST_FILE, listContent);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(LIST_FILE)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions('-c copy')
            .save(finalOutput)
            .on('end', resolve)
            .on('error', reject);
    });
}

// --- 3. ANA ORKESTRASYON DÖNGÜSÜ ---
async function runExecutionNode() {
    console.log("🚀 [SENTIRIC LABS] NATIVE Execution Node Başlatıldı...\n");

    try {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
        if (!fs.existsSync(TIMELINE_PATH)) throw new Error("timeline.json bulunamadı!");

        const rawData = fs.readFileSync(TIMELINE_PATH, 'utf-8');
        const projectData = JSON.parse(rawData);
        const timeline = projectData.timeline;
        
        console.log(`📑 Toplam ${timeline.length} sahne algılandı. Üretim başlıyor...\n`);

        const sceneVideos = [];

        for (let i = 0; i < timeline.length; i++) {
            const scene = timeline[i];
            const imgPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.jpg`);
            // 🔥 DİKKAT: Artık .wav kaydediyoruz
            const audioPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.wav`); 
            const videoPath = path.join(TEMP_DIR, `scene_${scene.scene_id}.mp4`);

            // A. Görseli İndir
            await downloadImage(scene.visual_prompt, imgPath);
            
            // B. Sesi Üret (Native gRPC & WAV Buffer)
            await generateAudioNative(scene.voiceover_text, audioPath);
            
            // C. Hareketi Kat ve MP4 Yap (Explicit Audio Mapping ile)
            await createSceneVideo(imgPath, audioPath, videoPath);
            
            sceneVideos.push(videoPath);
            console.log(`✅ Sahne ${scene.scene_id} Tamamlandı!\n`);
        }

        const finalOutput = path.join(OUTPUT_DIR, `WL_FINAL_${Date.now()}.mp4`);
        await concatScenes(sceneVideos, finalOutput);

        console.log(`🎉 [BAŞARILI] Kusursuz mimariyle ilk video üretildi!`);
        console.log(`📂 Dosya Yolu: ${finalOutput}\n`);

    } catch (error) {
        console.error("🚨 [SİSTEM ÇÖKTÜ]:", error);
    }
}

// Motoru Ateşle
runExecutionNode();