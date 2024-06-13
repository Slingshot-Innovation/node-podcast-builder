import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import ytdl from 'ytdl-core';
import fs from 'fs';
import { config } from 'dotenv';
import { execFileSync } from 'child_process';
import mp3Duration from 'mp3-duration';
import { parseString } from 'xml2js';
import { glob } from 'glob';
import { v4 as uuid } from 'uuid';
import { ElevenLabsClient } from "elevenlabs";
import { decode } from 'base64-arraybuffer';
import ffmpeg from 'fluent-ffmpeg';

config();

const app = express();
app.use(express.json());

const elevenLabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const NUM_CLIPS = 5;
const MAX_CLIP_LENGTH = 900; // 15 minutes in seconds

const uploadToSupabase = async (filePath) => {
    console.log(`Uploading ${filePath} to Supabase...`);
    const fileName = filePath.split('/').pop();
    const fileExtension = fileName.split('.').pop();
    const uniqueFilename = `${uuid()}.${fileExtension}`;
    const fileData = fs.readFileSync(filePath);
    const buffedInput = fileData.toString("base64");
    const { data, error } = await supabaseClient
        .storage
        .from('audio-files')
        .upload(uniqueFilename, decode(buffedInput), {
            contentType: 'audio/mpeg',
        });

    if (error) throw error;

    return `${process.env.SUPABASE_URL}/storage/v1/object/public/audio-files/${uniqueFilename}`;
};

const addEpisodeToDb = async (title, description, length) => {
    const { data, error } = await supabaseClient.from('episodes').insert([{ title, description, length }]).select();
    if (error) throw error;
    return data[0].id;
};

const updateClipInDb = async (episodeId, index, url, length, title, description, type, videoId = null) => {
    if (index === 0 && type === 'transition') return;

    const table = type === 'clip' ? 'clips' : type === 'transition' ? 'transitions' : 'intros';
    const record = { episode: episodeId, index, url, title, description, length };
    if (videoId) record.video_id = videoId;

    const { data, error } = await supabaseClient.from(table).insert(record);
    if (error) throw error;
};

const getAudioLength = (filePath) => {
    return new Promise((resolve, reject) => {
        mp3Duration(filePath, (err, duration) => {
            if (err) reject(err);
            resolve(duration);
        });
    });
};

const getYoutubeSearchQueries = async (topic) => {
    const queryResponse = {
        youtubeSearchQueries: [
            "first search term for Youtube here.",
            "second search term for Youtube here.",
            "third search term for Youtube here etc etc",
            "etc"
        ]
    };

    const messages = [
        {
            role: "system",
            content: `You are in charge of helping the user find content relevant to a specific topic: "${topic}".
                      Your job is to generate 3 YouTube search queries that contain necessary keywords to find the best videos on this topic.
                      Keep the queries concise and to the point.
                      The search query should be in JSON format. Return the object directly.`
        },
        {
            role: "user",
            content: `The topic is: "${topic}". 
                      Your response MUST be in JSON format: ${JSON.stringify(queryResponse)}. Return the object directly.`
        }
    ];
    const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
    const args = JSON.parse(response.choices[0].message.content);
    fs.appendFileSync('queries.txt', `${topic}: ${JSON.stringify(args.youtubeSearchQueries)}\n`);
    return args.youtubeSearchQueries;
};

const searchYoutube = async (query) => {
    const response = await youtube.search.list({
        part: 'snippet',
        q: query,
        maxResults: 5,
        type: 'video'
    });
    return response.data.items;
};

const extractCaptionsJson = (html) => {
    const startIndex = html.indexOf('"captions":');
    if (startIndex === -1) return null;

    const start = startIndex + '"captions":'.length;
    const endIndex = html.indexOf(',"videoDetails', start);
    if (endIndex === -1) return null;

    const captionsJsonStr = html.slice(start, endIndex).replace(/\n|\r/g, '');
    try {
        return JSON.parse(captionsJsonStr).playerCaptionsTracklistRenderer;
    } catch (e) {
        console.error("Error parsing JSON:", e);
        return null;
    }
};

const parseXmlToJson = (xml) => {
    return new Promise((resolve, reject) => {
        parseString(xml, { explicitArray: false }, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
};

const getYoutubeCaptions = async (videoId) => {
    try {
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const response = await axios.get(watchUrl, { headers: { 'Accept-Language': 'en-US' } });
        const captionsJson = extractCaptionsJson(response.data);
        if (!captionsJson) return [];

        const languagePreferences = ['en', 'en-GB', 'en-US'];
        let selectedCaptionTrack = null;

        for (const preferredLanguage of languagePreferences) {
            selectedCaptionTrack = captionsJson.captionTracks.find(track => track.languageCode === preferredLanguage);
            if (selectedCaptionTrack) break;
        }

        if (!selectedCaptionTrack && captionsJson.captionTracks.length) {
            selectedCaptionTrack = captionsJson.captionTracks[0];
        }

        if (!selectedCaptionTrack) return [];

        const captionsUrl = selectedCaptionTrack.baseUrl;
        const captionsResponse = await axios.get(captionsUrl);
        const captionsJsonObj = await parseXmlToJson(captionsResponse.data);
        if (!captionsJsonObj.transcript || !captionsJsonObj.transcript.text) return [];
        return captionsJsonObj.transcript.text.map(item => ({
            text: item._,
            start: parseFloat(item.$.start),
            duration: parseFloat(item.$.dur || '0.0')
        }));
    } catch (error) {
        console.error("Error:", error);
        return [];
    }
};

const extractBestPartOfTranscript = async (transcript, topic, queryTerm, targetAvgClipLength) => {
    const queryResponse = {
        start_time: "The start time of the chosen section that matches the transcript object.",
        end_time: "The end time of the chosen section that matches the transcript object.",
        reason: "The reason for choosing this section."
    };

    const messages = [
        {
            role: "system",
            content: `You are in charge of selecting the best part of a transcript for a podcast. 
                      The podcast is on ${queryTerm} and this is for a specific section on "${topic}".
                      Your job is to choose the best part of the transcript provided and explain why it was chosen.
                      You must return the start and end time for the section to be used.
                      Aim for an average clip length of ${targetAvgClipLength} seconds (i.e your chosen start_time minus end_time should be close to this value).`
        },
        {
            role: "user",
            content: `Here is the transcript you can choose from:
                      ${transcript}.
                      Your response must be in JSON format: ${JSON.stringify(queryResponse)}. Return the object directly.`
        }
    ];

    try {
        const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
        const args = JSON.parse(response.choices[0].message.content);
        if (!args.start_time || !args.end_time) {
            return [null, null, "No valid start and end times found."];
        }
        return [convertStringToFloat(args.start_time), convertStringToFloat(args.end_time), args.reason];
    } catch (error) {
        console.error("Error extracting best part of transcript:", error);
        throw error;
    }
};

const downloadAudioFromYoutube = (videoUrl, startTime, endTime, index) => {
    const outputFilename = `clip_${index}.mp3`;
    const options = { quality: 'highestaudio', begin: `${startTime}s`, end: `${endTime}s` };

    return new Promise((resolve, reject) => {
        const stream = ytdl(videoUrl, options);

        ffmpeg(stream)
            .audioCodec('libmp3lame')
            .save(outputFilename)
            .on('end', () => resolve(outputFilename))
            .on('error', reject);
    });
};

const cutClipToLength = (filePath, aimClipLength) => {
    const tempFilePath = `temp_${filePath}`;
    return new Promise((resolve, reject) => {
        ffmpeg(filePath)
            .setStartTime(0)
            .setDuration(aimClipLength)
            .save(tempFilePath)
            .on('end', () => {
                fs.renameSync(tempFilePath, filePath);
                resolve(filePath);
            })
            .on('error', reject);
    });
};

async function getAudioForWords(filepath, words) {
    console.log(`Generating audio for ${filepath}`)
    const headers = {
        'Accept': 'audio/mpeg',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
    };
    const body = JSON.stringify({
        text: words,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
            stability: 0.3,
            similarity_boost: 0.7,
        }
    });
    const voiceId = 'fJE3lSefh7YI494JMYYz';
    try {
        const response = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, body, {
            headers: headers,
            responseType: 'arraybuffer'
        });
        await fs.promises.writeFile(filepath, response.data);
        console.log(`Generated audio for ${filepath}`);
        return filepath;
    } catch (error) {
        throw new Error(`Error in generating audio: ${error}`);
    }
}

const getBestVideo = async (videos, query, topic) => {
    const queryResponse = {
        video_number: "The index of the video you choose here.",
        reason: "The reason for your choice."
    };

    const messages = [
        {
            role: "system",
            content: `You are in charge of selecting the best audio clip for section on "${query}" for a podcast on ${topic}.
                      Your job is to choose the best clip from the list of clip transcripts provided and explain why it was chosen.`
        },
        {
            role: "user",
            content: `Here are the clips you can choose from. Pick the clip that best fits the discussion topic of "${query}" for the podcast on ${topic}
                      ${JSON.stringify(videos)}
                      Your response should be in JSON format, like this example: ${JSON.stringify(queryResponse)}`
        }
    ];

    try {
        const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
        const args = JSON.parse(response.choices[0].message.content);
        const vidNum = parseInt(args.video_number);
        if (vidNum > videos.length) return null;
        if (vidNum < 1) return null;
        return { video: videos[vidNum - 1], reason: args.reason };
    } catch (error) {
        console.error("Error getting best video:", error);
        throw error;
    }
};

const createTransition = async (queryTerm, previousClip, clip) => {
    // const previousTitle = previousClip.snippet.title || 'Unknown Title';
    // const previousChannel = previousClip.snippet.channelTitle || 'Unknown Channel';
    // const previousDescription = previousClip.snippet.description || 'No description available';

    const queryResponse = { transition_text: "The transition text between the two clips." };

    const messages = [
        {
            role: "user",
            content: `You are in charge of creating a clip show using podcast clips.
                      The main topic of the show is "${queryTerm}". The previous clip that was chosen has just ended.
                      You have chosen the following clip to include next in the show:
                      ${clip.snippet.title} (by ${clip.snippet.channelTitle}) - ${clip.snippet.description}.
                      Your task is as follows: you must create a brief transition into this next clip.
                      The transition should be smooth and should flow well from any possible previous clip to the next clip. As such, do not worry about mentioning anything to do with the previous clip.
                      The transition text will be spoken by a voice actor and will be used to transition between the two clips.
                      Adjectives are unnecessary, do not use them.
                      The response should be in JSON format with the structure: ${JSON.stringify(queryResponse)}. Return the object directly.`
        }
    ];
    try {
        const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
        const args = JSON.parse(response.choices[0].message.content);
        return args.transition_text;
    } catch (error) {
        console.error("Error creating transition:", error);
        throw error;
    }
};

const getShowOutline = async (queryTerm) => {
    const showOutline = {
        podcast_structure: {
            episode_name: "Episode Name here",
            episode_description: "Episode Description here",
            topics: [
                "first topic",
                "second topic",
                "third topic etc etc",
                "etc"
            ]
        }
    };

    const messages = [
        {
            role: "system",
            content: `You are in charge of creating an episode of a podcast show using podcast clips.
                      The main topic of the show is "${queryTerm}". You must create the structure for the show so that the user can get the appropriate podcast clips to makeup the show.
                      The topic should be broad enough to allow for a variety of clips to be included.
                      Your response must be in JSON format with the structure: ${JSON.stringify(showOutline)}. Return the object directly.`
        },
        {
            role: "user",
            content: `You are in charge of creating an episode of a podcast show using podcast clips.
                      The main topic of the show is "${queryTerm}". You must create the structure for the show so that the user can get the appropriate podcast clips to makeup the show.
                      The topic should be broad enough to allow for a variety of clips to be included.
                      Your response must be in JSON format with the structure: ${JSON.stringify(showOutline)}. Return the object directly.`
        }
    ];

    try {
        const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error("Error getting show outline:", error);
        throw error;
    }
};

const introduceShow = async (queryTerm, clips) => {
    const queryResponse = { introduction_text: "The introduction text for the show." };

    const clipDescriptions = clips.map(clip => `${clip.snippet.title} (by ${clip.snippet.channelTitle}) - ${clip.snippet.description}`).join(", ");

    const messages = [
        {
            role: "user",
            content: `You are in charge of creating a clip show using podcast clips.
                      The main topic of the show is "${queryTerm}".
                      Your task is as follows: you must introduce the show to the audience.
                      You will do so through the introduce_show function, and will return the introduction text.
                      The introduction text will be spoken by a voice actor and will be used to introduce the show to the audience.
                      Adjectives are unnecessary, do not use them.
                      The clips that will be included in the show are as follows (and in this order). Just use this as a guideline for your intro, you do not need to exactly quote them:
                      ${clipDescriptions}
                      The response must be in JSON format with the structure: ${JSON.stringify(queryResponse)}. Return the object directly.`
        }
    ];

    try {
        const response = await openai.chat.completions.create({ model: "gpt-4o", messages, response_format: { type: "json_object" } });
        const args = JSON.parse(response.choices[0].message.content);
        return args.introduction_text;
    } catch (error) {
        console.error("Error introducing show:", error);
        throw error;
    }
};

const generateFileList = (numClips) => {
    const fileList = fs.createWriteStream('concat_list.txt');
    if (fs.existsSync('intro.mp3')) {
        fileList.write("file 'intro.mp3'\n");
    }
    for (let i = 0; i < numClips; i++) {
        if (fs.existsSync(`transition_${i}.mp3`)) {
            if (i > 0) {
                fileList.write(`file 'transition_${i}.mp3'\n`);
            }
        }
        if (fs.existsSync(`clip_${i}.mp3`)) {
            fileList.write(`file 'clip_${i}.mp3'\n`);
        }
    }
    if (fs.existsSync(`transition_${numClips}.mp3`)) {
        fileList.write(`file 'transition_${numClips}.mp3'\n`);
    }
    fileList.end();
};

const concatMp3Files = (numClips) => {
    generateFileList(numClips);

    const cmd = ['ffmpeg'];
    const inputs = [];
    if (fs.existsSync('intro.mp3')) {
        inputs.push('intro.mp3');
    }
    for (let i = 0; i < numClips; i++) {
        if (fs.existsSync(`transition_${i}.mp3`)) {
            if (i === 0) {
                inputs.push(`clip_${i}.mp3`);
            } else {
                inputs.push(`transition_${i}.mp3`);
                inputs.push(`clip_${i}.mp3`);
            }
        }
    }

    for (const inputFile of inputs) {
        cmd.push('-i', inputFile);
    }

    const filterComplexStr = inputs.map((_, i) => `[${i}:a]`).join('') + `concat=n=${inputs.length}:v=0:a=1[out]`;

    cmd.push('-filter_complex', filterComplexStr, '-map', '[out]', 'output.mp3');

    execFileSync('ffmpeg', cmd.slice(1), { stdio: 'inherit' });
};

const cleanUp = () => {
    const filePatterns = ['transition_*.mp3', 'clip_*.mp3', 'concat_list.txt', 'topics.txt', 'video_list.txt', 'output.mp3', 'intro.mp3'];
    for (const pattern of filePatterns) {
        const files = glob.sync(pattern);
        for (const file of files) {
            try {
                fs.unlinkSync(file);
            } catch (e) {
                console.error(`Error deleting file ${file}:`, e.message);
            }
        }
    }
};

const convertStringToFloat = (str) => {
    if (str == "N/A") return 0;
    const floatNumber = parseFloat(str);
    if (isNaN(floatNumber)) {
        throw new Error(`Cannot convert ${str} to a number`);
    }
    return floatNumber;
};

app.post('/create_episode', async (req, res) => {
    cleanUp();

    const { query, episodeLength } = req.body.req;
    console.log(`Creating episode for ${query} with requested length of ${Math.floor(episodeLength / 60)} mins.`);
    const seenClips = [];
    let totalLength = 0;

    try {
        const outline = await getShowOutline(query);
        const { topics, episode_name: episodeTitle, episode_description: episodeDescription } = outline.podcast_structure;
        const episodeId = await addEpisodeToDb(episodeTitle, episodeDescription, 0);
        let previousClip = { snippet: { title: "Introduction", description: "Introduction to the podcast show", channelTitle: "N/A" } };

        const introText = await introduceShow(query, seenClips);
        await getAudioForWords('intro.mp3', introText);
        const introUrl = await uploadToSupabase('intro.mp3');
        console.log("Uploaded intro to supabase");
        const introLength = await getAudioLength('intro.mp3');
        let floatIntroLength = convertStringToFloat(introLength);
        await updateClipInDb(episodeId, 0, introUrl, floatIntroLength, "Intro", "Introduction transition to the episode", 'intro');

        const targetAvgClipLength = episodeLength / topics.length;
        fs.writeFileSync('topics.txt', JSON.stringify(topics));

        for (let i = 0; i < topics.length; i++) {
            const searchQueries = await getYoutubeSearchQueries(topics[i]);
            let allVideos = [];

            for (const query of searchQueries) {
                const videos = await searchYoutube(query);
                allVideos = allVideos.concat(videos);
            }

            const transcriptsWithInfo = [];

            for (const video of allVideos) {
                if (!video) continue;
                const captions = await getYoutubeCaptions(video.id.videoId);
                if (!captions.length) continue;

                const transcript = captions.map(caption => `${caption.start}: ${caption.text}`).join('\n');
                const [startTime, endTime, reason] = await extractBestPartOfTranscript(transcript, topics[i], query, targetAvgClipLength);
                if (!startTime || !endTime) continue;
                const clippedTranscript = transcript.split('\n').slice(startTime, endTime);

                transcriptsWithInfo.push({
                    transcript: clippedTranscript,
                    start_time: startTime,
                    end_time: endTime,
                    video: video
                });
            }

            const bestVideoObj = await getBestVideo(allVideos, query, topics[i]);
            if (!bestVideoObj || !bestVideoObj.video) continue;
            let bestVideo = bestVideoObj.video;
            const bestTranscriptInfo = transcriptsWithInfo.find(transcript => transcript.video.id.videoId === bestVideo.id.videoId);
            if (!bestTranscriptInfo) continue;

            await downloadAudioFromYoutube(bestVideo.id.videoId, bestTranscriptInfo.start_time, bestTranscriptInfo.end_time, i);
            let aimClipLength = bestTranscriptInfo.end_time - bestTranscriptInfo.start_time;
            await cutClipToLength(`clip_${i}.mp3`, aimClipLength);
            const clipLength = aimClipLength;
            totalLength += clipLength;

            const clipUrl = await uploadToSupabase(`clip_${i}.mp3`);
            const clipTitle = bestVideo.snippet.title;
            const clipDescription = bestVideo.snippet.description;
            await updateClipInDb(episodeId, i, clipUrl, clipLength, clipTitle, clipDescription, 'clip', bestVideo.id.videoId);
            seenClips.push(bestVideo);

            const transitionText = await createTransition(query, previousClip, bestVideo);
            await getAudioForWords(`transition_${i}.mp3`, transitionText);
            const transitionLength = await getAudioLength(`transition_${i}.mp3`);
            totalLength += transitionLength;

            const transitionUrl = await uploadToSupabase(`transition_${i}.mp3`);
            const transitionTitle = "Transition";
            const transitionDescription = `Transition between ${previousClip.snippet.title} and ${clipTitle}`;
            await updateClipInDb(episodeId, i, transitionUrl, transitionLength, transitionTitle, transitionDescription, 'transition');

            previousClip = bestVideo;
        }

        concatMp3Files(topics.length);
        const finalAudioUrl = await uploadToSupabase('output.mp3');
        const finalEpisodeLength = await getAudioLength('output.mp3');
        await supabaseClient.from('episodes').update({ audio_url: finalAudioUrl, length: finalEpisodeLength }).eq('id', episodeId);
        console.log("Successfully created episode!");
        res.json({ message: "Show created successfully!", episode_id: episodeId });
    } catch (error) {
        console.error("Error creating episode:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

app.listen(5000, () => {
    console.log('Server is running on port 5000');
});
