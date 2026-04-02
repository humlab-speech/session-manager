const nanoid = require("nanoid");
const fs = require("fs");
const { execSync } = require("child_process");
const http = require("http");
const nodemailer = require("nodemailer");
const path = require("path");

class WhisperService {
    constructor(app) {
        this.app = app;
        this.preProcessTranscriptionPromises = [];
        this.transcriptionRunning = false;
        this.whisperReady = false;
        this.socketPath = process.env.WHISPERX_SOCKET_PATH || "/run/whisperx/whisperx.sock";
        // Track which model package is loaded in WhisperVault.
        // Starts as "multilingual" because the quadlet default is faster-whisper-large-v3.
        // Switched to "sv-standard" when Swedish is explicitly requested.
        this.currentPackage = null;
        this.currentOverridesKey = null;
        // Language name → ISO 639-1 code mapping (matches whisperx LANGUAGES dict).
        // WhisperVault expects ISO codes; the webclient sends full English names.
        this.languageToIso = {
            "afrikaans": "af",
            "albanian": "sq",
            "amharic": "am",
            "arabic": "ar",
            "armenian": "hy",
            "assamese": "as",
            "azerbaijani": "az",
            "bashkir": "ba",
            "basque": "eu",
            "belarusian": "be",
            "bengali": "bn",
            "bosnian": "bs",
            "breton": "br",
            "bulgarian": "bg",
            "cantonese": "yue",
            "catalan": "ca",
            "chinese": "zh",
            "croatian": "hr",
            "czech": "cs",
            "danish": "da",
            "dutch": "nl",
            "english": "en",
            "estonian": "et",
            "faroese": "fo",
            "finnish": "fi",
            "french": "fr",
            "galician": "gl",
            "georgian": "ka",
            "german": "de",
            "greek": "el",
            "gujarati": "gu",
            "haitian creole": "ht",
            "hausa": "ha",
            "hawaiian": "haw",
            "hebrew": "he",
            "hindi": "hi",
            "hungarian": "hu",
            "icelandic": "is",
            "indonesian": "id",
            "italian": "it",
            "japanese": "ja",
            "javanese": "jw",
            "kannada": "kn",
            "kazakh": "kk",
            "khmer": "km",
            "korean": "ko",
            "lao": "lo",
            "latin": "la",
            "latvian": "lv",
            "lingala": "ln",
            "lithuanian": "lt",
            "luxembourgish": "lb",
            "macedonian": "mk",
            "malagasy": "mg",
            "malay": "ms",
            "malayalam": "ml",
            "maltese": "mt",
            "maori": "mi",
            "marathi": "mr",
            "mongolian": "mn",
            "myanmar": "my",
            "nepali": "ne",
            "norwegian": "no",
            "nynorsk": "nn",
            "occitan": "oc",
            "pashto": "ps",
            "persian": "fa",
            "polish": "pl",
            "portuguese": "pt",
            "punjabi": "pa",
            "romanian": "ro",
            "russian": "ru",
            "sanskrit": "sa",
            "serbian": "sr",
            "shona": "sn",
            "sindhi": "sd",
            "sinhala": "si",
            "slovak": "sk",
            "slovenian": "sl",
            "somali": "so",
            "spanish": "es",
            "sundanese": "su",
            "swahili": "sw",
            "swedish": "sv",
            "tagalog": "tl",
            "tajik": "tg",
            "tamil": "ta",
            "tatar": "tt",
            "telugu": "te",
            "thai": "th",
            "tibetan": "bo",
            "turkish": "tr",
            "turkmen": "tk",
            "ukrainian": "uk",
            "urdu": "ur",
            "uzbek": "uz",
            "vietnamese": "vi",
            "welsh": "cy",
            "yiddish": "yi",
            "yoruba": "yo",
        };
        this.availableLanguages = [
            "Automatic Detection",
            ...Object.keys(this.languageToIso),
        ];

        this.transporter = nodemailer.createTransport({
            host: "smtp.umu.se",
            port: 25,
            secure: false, // true for port 465, false for other ports
            auth: {
                //user: "",
                //pass: "",
            },
        });

        (async () => {
            // Poll WhisperVault health endpoint over Unix Domain Socket.
            // The socket only appears once the container and model are ready.
            let backoff = 10 * 1000; // start at 10s
            const maxBackoff = 300 * 1000; // cap at 5min
            while (!this.whisperReady) {
                try {
                    const health = await this.whisperRequest("GET", "/health");
                    if (health && health.ready) {
                        this.whisperReady = true;
                        this.currentPackage = "multilingual";
                        const model = health.model || "unknown";
                        this.app.addLog(
                            `WhisperVault connected and ready (model: ${model}).`,
                            "info",
                        );
                    } else if (health && health.idle_unloaded) {
                        // Server is up but model is idle-unloaded — that's fine,
                        // /transcribe will auto-reload it.
                        this.whisperReady = true;
                        this.currentPackage = "multilingual";
                        this.app.addLog(
                            "WhisperVault connected (model idle-unloaded, will auto-reload on first transcription).",
                            "info",
                        );
                    } else {
                        throw new Error("Health check returned unexpected status: " + JSON.stringify(health));
                    }
                } catch (err) {
                    const briefErr = (err?.message || String(err)).split("\n")[0];
                    this.app.addLog(
                        `WhisperVault not ready: ${briefErr}. Retrying in ${Math.round(backoff / 1000)}s.`,
                        "warn",
                    );
                    await new Promise((resolve) => setTimeout(resolve, backoff));
                    backoff = Math.min(maxBackoff, backoff * 1.5);
                }
            }
        })();
    }

    init() {
        this.cancelRuns();

        // Start transcription queue only after WhisperVault is reachable
        const waitForWhisperReady = async () => {
            while (!this.whisperReady) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            this.app.addLog("Initiating transcription queue interval.", "info");
            // Run the transcription queue at a lower frequency to avoid tight looping
            // while the external service is transiently unavailable.
            setInterval(() => {
                if (this.whisperReady) {
                    this.runTranscriptionQueue();
                }
                // Silent skip when WhisperVault is not ready
            }, 15000); // 15s interval
        };

        waitForWhisperReady();
    }

    /**
     * Make an HTTP request to WhisperVault over the Unix Domain Socket.
     * @param {string} method - HTTP method (GET, POST)
     * @param {string} urlPath - URL path (e.g. /health, /transcribe, /models)
     * @param {object} [options] - Optional: { body, headers, timeout }
     * @returns {Promise<object>} Parsed JSON response
     */
    whisperRequest(method, urlPath, options = {}) {
        return new Promise((resolve, reject) => {
            const reqOptions = {
                socketPath: this.socketPath,
                path: urlPath,
                method: method,
                headers: options.headers || {},
                timeout: options.timeout || 30000,
            };

            const req = http.request(reqOptions, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse WhisperVault response: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on("error", (err) => reject(err));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("WhisperVault request timed out"));
            });

            if (options.body) {
                req.write(options.body);
            }
            req.end();
        });
    }

    /**
     * Send a multipart POST /transcribe request to WhisperVault.
     * @param {Buffer} audioBuffer - Audio file contents
     * @param {string} filename - Original filename
     * @param {object} params - Transcription parameters (language, diarize, output_format, etc.)
     * @returns {Promise<object>} Parsed JSON response with outputs.srt, outputs.txt, etc.
     */
    whisperTranscribe(audioBuffer, filename, params = {}) {
        return new Promise((resolve, reject) => {
            const boundary = "----WhisperBoundary" + Date.now().toString(16);
            const paramsJson = JSON.stringify(params);

            // Build multipart body
            const parts = [];
            // audio file part
            parts.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
                `Content-Type: audio/wav\r\n\r\n`
            ));
            parts.push(audioBuffer);
            parts.push(Buffer.from("\r\n"));
            // params JSON part
            parts.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="params"\r\n` +
                `Content-Type: application/json\r\n\r\n` +
                paramsJson + "\r\n"
            ));
            // closing boundary
            parts.push(Buffer.from(`--${boundary}--\r\n`));

            const body = Buffer.concat(parts);

            const reqOptions = {
                socketPath: this.socketPath,
                path: "/transcribe",
                method: "POST",
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "Content-Length": body.length,
                },
                // Transcription can take a long time for large files
                timeout: 3600000, // 1 hour
            };

            const req = http.request(reqOptions, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`WhisperVault transcription failed (HTTP ${res.statusCode}): ${data.substring(0, 500)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse WhisperVault transcription response: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on("error", (err) => reject(err));
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("WhisperVault transcription timed out"));
            });

            req.write(body);
            req.end();
        });
    }

    /**
     * Ensure the correct WhisperVault model package is loaded for the user's
     * chosen model.
     *
     * "kb-whisper" → sv-standard package (KB Whisper, Swedish-specific)
     * "whisper"    → multilingual package (Whisper large-v3, all languages)
     *
     * Calls POST /reload only when the currently loaded package differs from
     * the required one, so back-to-back transcriptions with the same model
     * incur no switching overhead.
     *
     * @param {string} modelId - "kb-whisper" or "whisper"
     * @returns {Promise<void>}
     */
    async ensureModelPackage(modelId, advancedOptions = {}) {
        const neededPackage = modelId === "kb-whisper" ? "sv-standard" : "multilingual";

        // Build reload-time overrides from advanced options
        const reloadOverrides = {};
        if (advancedOptions.beamSize !== undefined) {
            reloadOverrides.beam_size = Math.max(5, Math.min(10, Number(advancedOptions.beamSize) || 5));
        }
        if (advancedOptions.repetitionPenalty !== undefined) {
            reloadOverrides.repetition_penalty = Number(advancedOptions.repetitionPenalty);
        }
        if (advancedOptions.conditionOnPreviousText !== undefined) {
            reloadOverrides.condition_on_previous_text = !!advancedOptions.conditionOnPreviousText;
        }
        if (advancedOptions.vad !== undefined) {
            reloadOverrides.vad_method = advancedOptions.vad ? "pyannote" : "none";
        }
        if (advancedOptions.vadOnset !== undefined && advancedOptions.vad) {
            reloadOverrides.vad_onset = Number(advancedOptions.vadOnset);
        }

        // Check if we need a reload: different package OR different ASR options
        const overridesKey = JSON.stringify(reloadOverrides);
        if (this.currentPackage === neededPackage && this.currentOverridesKey === overridesKey) {
            return;
        }

        this.app.addLog(
            `Switching WhisperVault model: ${this.currentPackage || "(none)"} → ${neededPackage}`,
            "info",
        );

        const result = await this.whisperRequest("POST", "/reload", {
            body: JSON.stringify({ package: neededPackage, ...reloadOverrides }),
            headers: { "Content-Type": "application/json" },
            timeout: 120000, // model loading can take up to 2 min
        });

        this.currentPackage = neededPackage;
        this.currentOverridesKey = overridesKey;
        this.app.addLog(
            `WhisperVault model package loaded: ${neededPackage} (model: ${result.model})`,
            "info",
        );
    }

    async fetchTranscription(ws, user, msg) {
        msg.data.project;
        msg.data.session;
        msg.data.bundle;

        if (!(await this.userHasAccessToProject(user, msg.data.project))) {
            this.app.addLog(
                "User " +
                    user.eppn +
                    " attempted to fetch transcription without access to the project",
                "info",
            );
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: "User does not have access to this project",
                }),
            );
            return;
        }

        const queueItem = await this.app.apiServer.mongoose
            .model("TranscriptionQueueItem")
            .findOne({
                project: msg.data.project,
                session: msg.data.session,
                bundle: msg.data.bundle,
            });

        if (!queueItem) {
            this.app.addLog(
                "User " +
                    user.eppn +
                    " attempted to fetch transcription for a file that does not exist in the queue",
                "info",
            );
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: "File does not exist in the transcription queue",
                }),
            );
            return;
        }

        const outputPath =
            "/repositories/" +
            this.getRelativeAudioFilePath(
                queueItem.project,
                queueItem.session,
                queueItem.bundle,
            );
        //let outputPath = "/transcription-output/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle)+"transcription";

        let srtPath = outputPath + "transcription.srt";
        let textPath = outputPath + "transcription.txt";

        let srt = "";
        let text = "";

        try {
            srt = fs.readFileSync(srtPath, "utf8");
        } catch (err) {
            this.app.addLog(
                "Error reading transcription file: " + err,
                "error",
            );
        }

        try {
            text = fs.readFileSync(textPath, "utf8");
        } catch (err) {
            this.app.addLog(
                "Error reading transcription file: " + err,
                "error",
            );
        }

        ws.send(
            JSON.stringify({
                type: "cmd-result",
                requestId: msg.requestId,
                progress: "end",
                cmd: msg.cmd,
                result: true,
                data: { srt: srt, text: text },
            }),
        );
    }

    async userHasAccessToProject(user, project) {
        const Project = this.app.apiServer.mongoose.model("Project");
        let projectObj = await Project.findOne({ id: project });

        if (!projectObj) {
            return false;
        }

        let hasAccess = false;
        projectObj.members.forEach((member) => {
            if (member.username == user.username) {
                hasAccess = true;
            }
        });

        return hasAccess;
    }

    async fetchTranscriptionQueueItems(ws, user, msg) {
        //check that this user.eppn exists in the project designated by msg.data.project

        //get the mongoose model for Project
        const Project = this.app.apiServer.mongoose.model("Project");
        let project = await Project.findOne({ id: msg.data.project });

        if (!project) {
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: "Project does not exist",
                }),
            );
            return;
        }
        let hasAccess = false;
        project.members.forEach((member) => {
            if (
                member.username == user.username &&
                (member.role == "admin" || member.role == "analyzer")
            ) {
                hasAccess = true;
            }
        });

        if (!hasAccess) {
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message:
                        "User does not have the right access to this project to manage transcriptions.",
                }),
            );
            return;
        }

        //get the mongoose model for TranscriptionQueueItem
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
            "TranscriptionQueueItem",
        );
        let allItems = await TranscriptionQueueItem.find({
            status: { $in: ["queued", "running"] },
        }).sort({ updatedAt: 1 });
        let items = await TranscriptionQueueItem.find({
            project: msg.data.project,
        });

        //for each item - figure out it's place in the queue
        items.forEach((item) => {
            item.queuePosition = 0;
            item.queuePosition = allItems.findIndex((i) => i.id == item.id);
        });

        ws.send(
            JSON.stringify({
                type: "cmd-result",
                requestId: msg.requestId,
                progress: "end",
                cmd: msg.cmd,
                data: items,
                result: true,
            }),
        );
    }

    async addFileToTranscriptionQueue(ws, user, msg) {
        //check that this user has access to the project designated by msg.data.project

        //get the mongoose model for Project
        const Project = this.app.apiServer.mongoose.model("Project");
        let project = await Project.findOne({ id: msg.data.project });

        if (!project) {
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: "Project does not exist",
                }),
            );
            return;
        }

        let hasAccess = false;
        project.members.forEach((member) => {
            if (
                member.username == user.username &&
                (member.role == "admin" || member.role == "analyzer")
            ) {
                hasAccess = true;
            }
        });

        if (!hasAccess) {
            this.app.addLog(
                "User " +
                    user.eppn +
                    " attempted to add a file to the transcription queue without access to the project",
                "info",
            );
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: "User does not have access to this project",
                }),
            );
            return;
        }

        //get the mongoose model for TranscriptionQueueItem
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
            "TranscriptionQueueItem",
        );

        //check to see if this file is already in the queue
        let existingItem = await TranscriptionQueueItem.findOne({
            project: msg.data.project,
            session: msg.data.session,
            bundle: msg.data.bundle,
        });

        if (existingItem) {
            //set this item to the status 'queued' if it is not already
            if (existingItem.status != "queued") {
                existingItem.status = "queued";
                existingItem.language = msg.data.language
                    ? msg.data.language
                    : existingItem.language;
                existingItem.model = msg.data.model
                    ? msg.data.model
                    : existingItem.model;
                existingItem.diarize = msg.data.diarize !== undefined
                    ? msg.data.diarize
                    : existingItem.diarize;
                if (msg.data.advancedOptions) {
                    existingItem.advancedOptions = msg.data.advancedOptions;
                }
                existingItem.updatedAt = new Date();
                existingItem.userNotified = false;
                await existingItem.save();
            }

            this.app.addLog(
                "User " + user.eppn + " requested re-transcription of a file.",
                "info",
            );
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: true,
                    message: "Re-doing transcription of file.",
                }),
            );
            return;
        }

        //add to the mongo db
        let item = new TranscriptionQueueItem({
            id: nanoid.nanoid(),
            project: msg.data.project,
            session: msg.data.session,
            bundle: msg.data.bundle,
            initiatedByUser: user.eppn,
            status: "queued",
            language: msg.data.language,
            model: msg.data.model,
            diarize: !!msg.data.diarize,
            advancedOptions: msg.data.advancedOptions || {},
            error: "",
            log: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            finishedAt: null,
            preProcessing: "queued",
            preProcessingRuns: 0,
            transcriptionData: {},
            userNotified: false,
            queuePosition: -1,
        });

        await item.save();

        this.app.addLog(
            "User " + user.eppn + " added a file to the transcription queue",
            "info",
        );
        ws.send(
            JSON.stringify({
                type: "cmd-result",
                requestId: msg.requestId,
                progress: "end",
                cmd: msg.cmd,
                result: true,
            }),
        );
    }

    async removeTranscriptionFromQueue(ws, user, msg) {
        try {
            // Check that this user has access to the project designated by msg.data.project
            if (!(await this.userHasAccessToProject(user, msg.data.project))) {
                this.app.addLog(
                    `User ${user.eppn} attempted to remove a file from the transcription queue without access to the project`,
                    "info",
                );
                ws.send(
                    JSON.stringify({
                        type: "cmd-result",
                        requestId: msg.requestId,
                        progress: "end",
                        cmd: msg.cmd,
                        result: false,
                        message: "User does not have access to this project",
                    }),
                );
                return;
            }

            // Get the mongoose model for TranscriptionQueueItem
            const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
                "TranscriptionQueueItem",
            );

            // Find the item in the transcription queue
            const item = await TranscriptionQueueItem.findOne({
                project: msg.data.project,
                session: msg.data.session,
                bundle: msg.data.bundle,
            });

            //if this item has transcriptionData, just set the status back to "complete", otherwise delete it
            if (item && item.transcriptionData && item.transcriptionData.data) {
                item.status = "complete";
                item.userNotified = true;
                item.updatedAt = new Date();
                await item.save();
                this.app.addLog(
                    `User ${user.eppn} marked a file as complete in the transcription queue`,
                    "info",
                );
                ws.send(
                    JSON.stringify({
                        type: "cmd-result",
                        requestId: msg.requestId,
                        progress: "end",
                        cmd: msg.cmd,
                        result: true,
                    }),
                );
            } else if (item) {
                // Remove this item
                // Use deleteOne instead of remove
                await TranscriptionQueueItem.deleteOne({ _id: item._id });

                this.app.addLog(
                    `User ${user.eppn} removed a file from the transcription queue`,
                    "info",
                );
                ws.send(
                    JSON.stringify({
                        type: "cmd-result",
                        requestId: msg.requestId,
                        progress: "end",
                        cmd: msg.cmd,
                        result: true,
                    }),
                );
            } else {
                this.app.addLog(
                    `User ${user.eppn} attempted to remove a file from the transcription queue that does not exist`,
                    "info",
                );
                ws.send(
                    JSON.stringify({
                        type: "cmd-result",
                        requestId: msg.requestId,
                        progress: "end",
                        cmd: msg.cmd,
                        result: false,
                        message:
                            "File does not exist in the transcription queue",
                    }),
                );
            }
        } catch (error) {
            // Handle errors
            this.app.addLog(
                `Error removing transcription queue item: ${error.message}`,
                "error",
            );
            ws.send(
                JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: "end",
                    cmd: msg.cmd,
                    result: false,
                    message: `An error occurred: ${error.message}`,
                }),
            );
        }
    }

    async cancelRuns() {
        //this method just cancels any active runs by setting their status back to 'queued'
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
            "TranscriptionQueueItem",
        );
        let items = await TranscriptionQueueItem.find({
            status: { $in: ["queued", "running"] },
        });

        for (let key in items) {
            let item = items[key];
            //check if the item is running
            if (item.status == "running") {
                item.status = "queued";
                item.updatedAt = new Date();
                await item.save();
            }
        }
    }

    async runTranscriptionQueue() {
        //this.app.addLog("Checking transcription queue", "debug");

        this.transcriptionDebug = process.env.TRANSCRIPTION_DEBUG
            ? process.env.TRANSCRIPTION_DEBUG
            : false;

        //get all items in the database queue that has the status 'queued' or 'running'
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
            "TranscriptionQueueItem",
        );
        let items = await TranscriptionQueueItem.find({
            status: { $in: ["queued", "running"] },
        }).sort({ updatedAt: 1 });

        if (this.transcriptionDebug) {
            this.app.addLog(
                "Transcription queue items (queued or running): " +
                    items.length,
                "debug",
            );
        }

        //check if we have any item with status 'running' which have been running for more than 1 day
        //if so, assume something went wrong and mark them as errored
        /* disabled this because I think it might cause problems with parallellism with the item.save() calls
        for(let key in items) {
            let item = items[key];
            //check if the item is running
            if(item.status == 'running') {
                let now = new Date();
                let diff = now - item.updatedAt;
                if(diff > 86400000) {
                    item.status = 'error';
                    item.log = "Transcription has been running for more than 24 hours";
                    item.updatedAt = new Date();
                    await item.save();
                }
            }
        }
        */

        //before items can be transcribed, they need to through pre-processing in the form of being converted to 16bit wav mono files
        items.forEach((item) => {
            //check if the item is queued
            if (item.status == "queued" && item.preProcessing == "queued") {
                //run the pre-processing
                if (item.preProcessing == "queued") {
                    this.preProcessTranscriptionPromises.push(
                        this.preProcessTranscription(item),
                    );
                }
            }
        });

        if (items.length == 0) {
            return;
        }
        let nextInQueue = items[0];

        if (this.transcriptionDebug) {
            this.app.addLog(
                "Next in queue: " +
                    (nextInQueue
                        ? nextInQueue.project +
                          "/" +
                          nextInQueue.session +
                          "/" +
                          nextInQueue.bundle
                        : "none"),
                "debug",
            );
        }

        if (
            nextInQueue &&
            nextInQueue.preProcessing == "complete" &&
            nextInQueue.status == "queued" &&
            this.transcriptionRunning == false
        ) {
            this.app.addLog(
                "Starting transcription of " +
                    nextInQueue.project +
                    "/" +
                    nextInQueue.session +
                    "/" +
                    nextInQueue.bundle,
                "info",
            );

            this.transcriptionRunning = true;
            // Double-wrapped promise handling to catch both sync throws and async rejections
            Promise.resolve()
                .then(() => this.initTranscription(nextInQueue))
                .then(() => {
                    this.app.addLog(
                        "Transcription of " +
                            nextInQueue.project +
                            "/" +
                            nextInQueue.session +
                            "/" +
                            nextInQueue.bundle +
                            " complete",
                        "info",
                    );
                })
                .catch((err) => {
                    this.app.addLog(
                        "Error starting transcription of " +
                            nextInQueue.project +
                            "/" +
                            nextInQueue.session +
                            "/" +
                            nextInQueue.bundle +
                            ": " +
                            (err.stack || err.message || err),
                        "error",
                    );
                })
                .finally(() => {
                    this.transcriptionRunning = false;
                });
        } else {
            if (nextInQueue && nextInQueue.preProcessing == "error") {
                //if the pre-processing failed, remove it from the queue by marking the item as errored
                nextInQueue.status = "error";
                nextInQueue.updatedAt = new Date();
                await nextInQueue.save();
            }

            if (this.transcriptionDebug) {
                this.app.addLog(
                    "Not starting transcription of " +
                        (nextInQueue
                            ? nextInQueue.project +
                              "/" +
                              nextInQueue.session +
                              "/" +
                              nextInQueue.bundle
                            : "none") +
                        " because:",
                    "debug",
                );
                if (this.transcriptionRunning) {
                    this.app.addLog(
                        "Transcription is already running",
                        "debug",
                    );
                }
                if (nextInQueue) {
                    if (nextInQueue.preProcessing != "complete") {
                        this.app.addLog(
                            "Pre-processing is not complete for " +
                                nextInQueue.project +
                                "/" +
                                nextInQueue.session +
                                "/" +
                                nextInQueue.bundle,
                            "debug",
                        );
                    }
                    if (nextInQueue.status != "queued") {
                        this.app.addLog(
                            "Status is not queued for " +
                                nextInQueue.project +
                                "/" +
                                nextInQueue.session +
                                "/" +
                                nextInQueue.bundle,
                            "debug",
                        );
                    }
                }
            }
        }

        this.notifyUsers();
    }

    async notifyUsers() {
        //check if any items have been transcribed and the user has not been notified, also check that ALL of the users files have been transcribed before sending out a notification
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model(
            "TranscriptionQueueItem",
        );

        const uniqueUsers = await TranscriptionQueueItem.distinct(
            "initiatedByUser",
            { status: "complete", userNotified: false },
        );
        uniqueUsers.forEach(async (user) => {
            let userItems = await TranscriptionQueueItem.find({
                initiatedByUser: user,
                userNotified: false,
            });
            let allItemsComplete = true;
            userItems.forEach((item) => {
                if (item.status != "complete" && item.status != "error") {
                    allItemsComplete = false;
                }
            });

            if (allItemsComplete) {
                //send notification
                this.app.addLog(
                    "Sending transcription complete notification to user " +
                        user,
                    "info",
                );
                this.notifyUser(user);

                //mark all items as userNotified
                userItems.forEach(async (item) => {
                    item.userNotified = true;
                    await item.save();
                });
            }
        });
    }

    async notifyUser(eppn) {
        //if the eppn is <something>@example.com then it is a test user and we should not send an email
        if (eppn.indexOf("@example.com") > -1) {
            return;
        }

        //email the user that their transcription is complete

        //get the mongoose model for User
        const User = this.app.apiServer.mongoose.model("User");
        let userObj = await User.findOne({ eppn: eppn });

        if (!userObj) {
            this.app.addLog("Error: User " + eppn + " does not exist", "error");
            return;
        }

        //send email
        this.transporter.sendMail({
            from: '"Humlab VISP system" <no-reply@visp.humlab.umu.se>',
            to: userObj.email,
            subject: "VISP transcription complete",
            text: "The trascription of your files is now complete. You can download the transcription files from the VISP interface at https://visp.humlab.umu.se",
        });
    }

    getFileNameWithoutExtension(fileName) {
        return fileName.split(".").slice(0, -1).join(".");
    }

    getRelativeAudioFilePath(project, session, bundle) {
        let bundleName = this.getFileNameWithoutExtension(bundle);
        return `${project}/Data/VISP_emuDB/${session}_ses/${bundleName}_bndl/`;
    }

    async preProcessTranscription(queueItem) {
        this.app.addLog(
            "Pre-processing file for transcription: " +
                queueItem.project +
                "/" +
                queueItem.session +
                "/" +
                queueItem.bundle,
            "info",
        );
        queueItem.preProcessing = "running";
        queueItem.updatedAt = new Date();
        await queueItem.save();

        //convert the file to 16bit wav mono (with ffmpeg) and put the out in /transcription-queued/<project>/<session>/<bundle>.wav
        //then set the queueItem.preProcessing to complete

        let bundleFilenameWithoutExt = this.getFileNameWithoutExtension(
            queueItem.bundle,
        );
        let sourcePath =
            "/repositories/" +
            this.getRelativeAudioFilePath(
                queueItem.project,
                queueItem.session,
                queueItem.bundle,
            );
        let destPath =
            "/transcription-queued/" +
            this.getRelativeAudioFilePath(
                queueItem.project,
                queueItem.session,
                queueItem.bundle,
            );
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }

        try {
            fs.accessSync(
                destPath + "/" + bundleFilenameWithoutExt + ".wav",
                fs.constants.R_OK,
            );
            this.app.addLog(
                "File already exists in destination path - skipping and marking as pre-processed.",
                "info",
            );
            queueItem.preProcessing = "complete";
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return;
        } catch (err) {
            // File does not exist, proceed with conversion
        }

        try {
            execSync(
                `ffmpeg -i "${sourcePath}${queueItem.bundle}" -acodec pcm_s16le -ac 1 -ar 16000 "${destPath}${bundleFilenameWithoutExt}.wav"`,
                { stdio: "pipe" },
            );
            queueItem.error = "";
            queueItem.preProcessing = "complete";
            queueItem.updatedAt = new Date();
            await queueItem.save();
        } catch (err) {
            this.app.addLog(
                "Error converting file to 16bit wav mono: " + err.toString(),
                "error",
            );
            queueItem.error =
                "Error converting file to 16bit wav mono: " + err.toString();
            queueItem.status = "error";
            queueItem.preProcessing = "error";
            queueItem.updatedAt = new Date();
            await queueItem.save();
        }
    }

    async initTranscription(queueItem) {
        let filePath =
            "/transcription-queued/" +
            this.getRelativeAudioFilePath(
                queueItem.project,
                queueItem.session,
                queueItem.bundle,
            );
        const outputPath =
            "/repositories/" +
            this.getRelativeAudioFilePath(
                queueItem.project,
                queueItem.session,
                queueItem.bundle,
            );

        //check that filePath exists, if it doesn't then assume the pre-processed file was deleted and mark the queueItem for pre-processing again
        //but keep an eye on the preProcessingRuns so we don't get stuck in a loop
        queueItem.preProcessingRuns = queueItem.preProcessingRuns + 1;
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (err) {
            this.app.addLog(err, "warn");
            queueItem.error = "Error: " + err;
            if (queueItem.preProcessingRuns > 10) {
                queueItem.preProcessing = "error - too many tries";
            } else {
                queueItem.preProcessing = "queued";
            }
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return;
        }

        //mkdir outputPath
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        queueItem.error = "";
        queueItem.status = "running";
        queueItem.updatedAt = new Date();
        await queueItem.save();

        //make it lowercase, unless it is "Automatic Detection"
        const selectedLanguage =
            queueItem.language != "Automatic Detection"
                ? queueItem.language.toLowerCase()
                : null;

        // Convert full language name to ISO 639-1 code for WhisperVault
        const languageCode = selectedLanguage
            ? this.languageToIso[selectedLanguage] || selectedLanguage
            : null;

        // Read the pre-processed audio file
        const audioFilePath = filePath + queueItem.bundle;
        let fileBuffer;
        try {
            fileBuffer = fs.readFileSync(audioFilePath);
        } catch (err) {
            throw new Error(`Failed to read audio file ${audioFilePath}: ${err.message}`);
        }

        // Build WhisperVault transcription parameters
        const transcribeParams = {
            output_format: ["srt", "txt"],
        };

        // Set language (WhisperVault uses ISO-639-1 codes; null = auto-detect)
        if (languageCode) {
            transcribeParams.language = languageCode;
        }

        // Enable speaker diarization if requested
        if (queueItem.diarize) {
            transcribeParams.diarize = true;
        }

        // Ensure the right model package is loaded based on user's model choice:
        //   kb-whisper → KB Whisper (sv-standard),  whisper → Whisper large-v3 (multilingual)
        try {
            await this.ensureModelPackage(
                queueItem.model || "whisper",
                queueItem.advancedOptions || {},
            );
        } catch (err) {
            throw new Error(`Failed to switch WhisperVault model package: ${err.message}`);
        }

        try {
            this.app.addLog(
                `Sending transcription request to WhisperVault: ${queueItem.bundle} ` +
                `(language: ${transcribeParams.language || "auto"})`,
                "info",
            );

            const result = await this.whisperTranscribe(
                fileBuffer,
                queueItem.bundle,
                transcribeParams,
            );

            // Write SRT output directly from response
            if (result.outputs && result.outputs.srt) {
                fs.writeFileSync(outputPath + "/transcription.srt", result.outputs.srt);
            } else {
                throw new Error("WhisperVault response missing SRT output");
            }

            // Write TXT output (use response if available, otherwise convert from SRT)
            if (result.outputs && result.outputs.txt) {
                fs.writeFileSync(outputPath + "/transcription.txt", result.outputs.txt);
            } else {
                this.convertSrtToTxt(outputPath);
            }

            this.app.addLog(
                `Transcription complete: ${result.language || "unknown"} language, ` +
                `${(result.segments || []).length} segments, ${result.duration_seconds || "?"}s processing time`,
                "info",
            );

            queueItem.transcriptionData = {
                language: result.language,
                duration_seconds: result.duration_seconds,
                segmentCount: (result.segments || []).length,
            };
            queueItem.status = "complete";
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return result;
        } catch (err) {
            // Robust error serialization: try message, stack, then JSON stringify
            let errStr = err.message || err.toString();
            if (err.stack) {
                errStr = err.stack;
            } else {
                try {
                    errStr = JSON.stringify(err);
                } catch (jsonErr) {
                    // If JSON.stringify fails, just use string representation
                    errStr = String(err);
                }
            }
            
            this.app.addLog(
                "Transcription failed for " + queueItem.project + "/" + 
                queueItem.session + "/" + queueItem.bundle + ": " + errStr,
                "error",
            );
            queueItem.error = "Transcription failed: " + errStr;
            queueItem.status = "error";
            queueItem.updatedAt = new Date();
            await queueItem.save();
            
            // Return gracefully without throwing - allows queue processing to continue
            return;
        }
    }

    convertSrtToTxt(path, writeToFile = true) {
        //now create txt version of the srt by strippping out the timecodes
        let srt = "";
        try {
            srt = fs.readFileSync(path + "/transcription.srt", "utf8");
        } catch (err) {
            this.app.addLog(
                "Error reading transcription file: " + err,
                "error",
            );
            return;
        }

        // Regex to match SRT timestamps (e.g., 00:00:00,000 --> 00:00:04,000)
        const timestampRegex =
            /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/gm;
        const indexLineRegex = /^\d+$/gm; // Matches index numbers like "1", "2", etc.

        // Remove timestamps and index lines
        const strippedContent = srt
            .replace(timestampRegex, "") // Remove timestamps
            .replace(indexLineRegex, "") // Remove index numbers
            .replace(/^\s*[\r\n]/gm, ""); // Remove empty lines

        if (writeToFile) {
            fs.writeFileSync(path + "/transcription.txt", strippedContent);
        }

        return strippedContent;
    }

    async shutdown() {
        await Promise.all(this.preProcessTranscriptionPromises);
        return true;
    }
}

module.exports = WhisperService;
