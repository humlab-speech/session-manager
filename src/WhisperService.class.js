const { nanoid } = require('nanoid');
const fs = require('fs');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const { Blob } = require('buffer');
const http = require('http');
const nodemailer = require('nodemailer');

class WhisperService {
    constructor(app) {
        this.app = app;
        this.preProcessTranscriptionPromises = [];
        this.transcriptionRunning = false;
        this.gradioConn = null;
        this.gradioReady = false;
        //languages in the model
        this.availableLanguages = ['afrikaans', 'albanian', 'amharic', 'arabic', 'armenian', 'assamese', 'azerbaijani', 'bashkir', 'basque', 'belarusian', 'bengali', 'bosnian', 'breton', 'bulgarian', 'cantonese', 'catalan', 'chinese', 'croatian', 'czech', 'danish', 'dutch', 'english', 'estonian', 'faroese', 'finnish', 'french', 'galician', 'georgian', 'german', 'greek', 'gujarati', 'haitian creole', 'hausa', 'hawaiian', 'hebrew', 'hindi', 'hungarian', 'icelandic', 'indonesian', 'italian', 'japanese', 'javanese', 'kannada', 'kazakh', 'khmer', 'korean', 'lao', 'latin', 'latvian', 'lingala', 'lithuanian', 'luxembourgish', 'macedonian', 'malagasy', 'malay', 'malayalam', 'maltese', 'maori', 'marathi', 'mongolian', 'myanmar', 'nepali', 'norwegian', 'nynorsk', 'occitan', 'pashto', 'persian', 'polish', 'portuguese', 'punjabi', 'romanian', 'russian', 'sanskrit', 'serbian', 'shona', 'sindhi', 'sinhala', 'slovak', 'slovenian', 'somali', 'spanish', 'sundanese', 'swahili', 'swedish', 'tagalog', 'tajik', 'tamil', 'tatar', 'telugu', 'thai', 'tibetan', 'turkish', 'turkmen', 'ukrainian', 'urdu', 'uzbek', 'vietnamese', 'welsh', 'yiddish', 'yoruba', 'Automatic Detection'];


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
            const gradio = await import('@gradio/client');
            const { Client, FileData } = gradio;
            while (!this.gradioReady) {
                try {
                    this.gradioConn = await Client.connect('http://whisper:7860');
                    this.gradioReady = true;
                    this.app.addLog("Whisper service connected and ready.", "info");
                } catch (err) {
                    this.app.addLog("Error connecting to Whisper service, will try again.", "warn");
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds before retrying
                }
            }
        })();
    
        const waitForGradioReady = async () => {
            while (!this.gradioReady) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            this.app.addLog("Initiating transcription queue interval.", "info");
            setInterval(() => {
                this.runTranscriptionQueue();
            }, 5000);
        };
    
        waitForGradioReady();

    }

    init() {
        this.cancelRuns();
    }

    async fetchTranscription(ws, user, msg) {
        msg.data.project;
        msg.data.session;
        msg.data.bundle;

        if(!await this.userHasAccessToProject(user, msg.data.project)) {
            this.app.addLog("User "+user.eppn+" attempted to fetch transcription without access to the project", "info");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User does not have access to this project" }));
            return;
        }

        const queueItem = await this.app.apiServer.mongoose.model('TranscriptionQueueItem').findOne({
            project: msg.data.project,
            session: msg.data.session,
            bundle: msg.data.bundle
        });

        if(!queueItem) {
            this.app.addLog("User "+user.eppn+" attempted to fetch transcription for a file that does not exist in the queue", "info");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "File does not exist in the transcription queue" }));
            return;
        }



        const outputPath = "/repositories/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle);
        //let outputPath = "/transcription-output/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle)+"transcription";

        let srtPath = outputPath+"transcription.srt";
        let textPath = outputPath+"transcription.txt";

        let srt = "";
        let text = "";

        try {
            srt = fs.readFileSync(srtPath, 'utf8');
        }
        catch(err) {
            this.app.addLog("Error reading transcription file: "+err, "error");
        }

        try {
            text = fs.readFileSync(textPath, 'utf8');
        }
        catch(err) {
            this.app.addLog("Error reading transcription file: "+err, "error");
        }

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true, data: { srt: srt, text: text } }));
    }

    async userHasAccessToProject(user, project) {
        const Project = this.app.apiServer.mongoose.model('Project');
        let projectObj = await Project.findOne({ id: project });

        if(!projectObj) {
            return false;
        }

        let hasAccess = false;
        projectObj.members.forEach(member => {
            if(member.username == user.username) {
                hasAccess = true;
            }
        });

        return hasAccess;
    }

    async fetchTranscriptionQueueItems(ws, user, msg) {
        //check that this user.eppn exists in the project designated by msg.data.project

        //get the mongoose model for Project
        const Project = this.app.apiServer.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.data.project });

        if(!project) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project does not exist" }));
            return;
        }
        let hasAccess = false;
        project.members.forEach(member => {
            if(member.username == user.username && (member.role == 'admin' || member.role == 'analyzer')) {
                hasAccess = true;
            }
        });

        if(!hasAccess) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User does not have the right access to this project to manage transcriptions." }));
            return;
        }

        //get the mongoose model for TranscriptionQueueItem
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');
        let allItems = await TranscriptionQueueItem.find({ status: { $in: ['queued', 'running'] } }).sort({ updatedAt: 1 });
        let items = await TranscriptionQueueItem.find({ project: msg.data.project });

        //for each item - figure out it's place in the queue
        items.forEach(item => {
            item.queuePosition = 0;
            item.queuePosition = allItems.findIndex(i => i.id == item.id);
        });

        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, data: items, result: true }));
    }

    async addFileToTranscriptionQueue(ws, user, msg) {

        //check that this user has access to the project designated by msg.data.project

        //get the mongoose model for Project
        const Project = this.app.apiServer.mongoose.model('Project');
        let project = await Project.findOne({ id: msg.data.project });

        if(!project) {
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "Project does not exist" }));
            return;
        }

        let hasAccess = false;
        project.members.forEach(member => {
            if(member.username == user.username && (member.role == 'admin' || member.role == 'analyzer')) {
                hasAccess = true;
            }
        });

        if(!hasAccess) {
            this.app.addLog("User "+user.eppn+" attempted to add a file to the transcription queue without access to the project", "info");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: false, message: "User does not have access to this project" }));
            return;
        }


        //get the mongoose model for TranscriptionQueueItem
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');

        //check to see if this file is already in the queue
        let existingItem = await TranscriptionQueueItem.findOne({
            project: msg.data.project,
            session: msg.data.session,
            bundle: msg.data.bundle
        });

        if(existingItem) {
            //set this item to the status 'queued' if it is not already
            if(existingItem.status != 'queued') {
                existingItem.status = 'queued';
                existingItem.language = msg.data.language ? msg.data.language : existingItem.language;
                existingItem.updatedAt = new Date();
                existingItem.userNotified = false;
                await existingItem.save();
            }

            this.app.addLog("User "+user.eppn+" requested re-transcription of a file.", "info");
            ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true, message: "Re-doing transcription of file." }));
            return;
        }

        //add to the mongo db
        let item = new TranscriptionQueueItem({
            id: nanoid(),
            project: msg.data.project,
            session: msg.data.session,
            bundle: msg.data.bundle,
            initiatedByUser: user.eppn,
            status: "queued",
            language: msg.data.language,
            error: "",
            log: "",
            createdAt: new Date(),
            updatedAt: new Date(),
            finishedAt: null,
            preProcessing: "queued",
            preProcessingRuns: 0,
            transcriptionData: {},
            userNotified: false,
            queuePosition: -1
        });

        await item.save();

        this.app.addLog("User "+user.eppn+" added a file to the transcription queue", "info");
        ws.send(JSON.stringify({ type: "cmd-result", requestId: msg.requestId, progress: 'end', cmd: msg.cmd, result: true }));
    }

    async removeTranscriptionFromQueue(ws, user, msg) {
        try {
            // Check that this user has access to the project designated by msg.data.project
            if (!await this.userHasAccessToProject(user, msg.data.project)) {
                this.app.addLog(
                    `User ${user.eppn} attempted to remove a file from the transcription queue without access to the project`,
                    "info"
                );
                ws.send(JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: 'end',
                    cmd: msg.cmd,
                    result: false,
                    message: "User does not have access to this project"
                }));
                return;
            }
    
            // Get the mongoose model for TranscriptionQueueItem
            const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');
    
            // Find the item in the transcription queue
            const item = await TranscriptionQueueItem.findOne({
                project: msg.data.project,
                session: msg.data.session,
                bundle: msg.data.bundle
            });


            //if this item has transcriptionData, just set the status back to "complete", otherwise delete it
            if(item && item.transcriptionData && item.transcriptionData.data) {
                item.status = 'complete';
                item.userNotified = true;
                item.updatedAt = new Date();
                await item.save();
                this.app.addLog(
                    `User ${user.eppn} marked a file as complete in the transcription queue`,
                    "info"
                );
                ws.send(JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: 'end',
                    cmd: msg.cmd,
                    result: true
                }));
            }
            else if (item) { // Remove this item
                // Use deleteOne instead of remove
                await TranscriptionQueueItem.deleteOne({ _id: item._id });
    
                this.app.addLog(
                    `User ${user.eppn} removed a file from the transcription queue`,
                    "info"
                );
                ws.send(JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: 'end',
                    cmd: msg.cmd,
                    result: true
                }));
            } else {
                this.app.addLog(
                    `User ${user.eppn} attempted to remove a file from the transcription queue that does not exist`,
                    "info"
                );
                ws.send(JSON.stringify({
                    type: "cmd-result",
                    requestId: msg.requestId,
                    progress: 'end',
                    cmd: msg.cmd,
                    result: false,
                    message: "File does not exist in the transcription queue"
                }));
            }
        } catch (error) {
            // Handle errors
            this.app.addLog(`Error removing transcription queue item: ${error.message}`, "error");
            ws.send(JSON.stringify({
                type: "cmd-result",
                requestId: msg.requestId,
                progress: 'end',
                cmd: msg.cmd,
                result: false,
                message: `An error occurred: ${error.message}`
            }));
        }
    }

    async cancelRuns() {
        //this method just cancels any active runs by setting their status back to 'queued'
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');
        let items = await TranscriptionQueueItem.find({ status: { $in: ['queued', 'running'] } });

        for(let key in items) {
            let item = items[key];
            //check if the item is running
            if(item.status == 'running') {
                item.status = 'queued';
                item.updatedAt = new Date();
                await item.save();
            }
        }
    }

    async runTranscriptionQueue() {
        //this.app.addLog("Checking transcription queue", "debug");

        this.transcriptionDebug = process.env.TRANSCRIPTION_DEBUG ? process.env.TRANSCRIPTION_DEBUG : false;

        //get all items in the database queue that has the status 'queued' or 'running'
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');
        let items = await TranscriptionQueueItem.find({ status: { $in: ['queued', 'running'] } }).sort({ updatedAt: 1 });

        if(this.transcriptionDebug) {
            this.app.addLog("Transcription queue items (queued or running): "+items.length, "debug");
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
        items.forEach(item => {
            //check if the item is queued
            if(item.status == "queued" && item.preProcessing == "queued") {
                //run the pre-processing
                if(item.preProcessing == 'queued') {
                    this.preProcessTranscriptionPromises.push(this.preProcessTranscription(item));
                }
            }
        });

        if(items.length == 0) {
            return;
        }
        let nextInQueue = items[0];

        if(this.transcriptionDebug) {
            this.app.addLog("Next in queue: "+(nextInQueue ? nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle : "none"), "debug");
        }

        if(nextInQueue && nextInQueue.preProcessing == 'complete' && nextInQueue.status == 'queued' && this.transcriptionRunning == false) {
            this.app.addLog("Starting transcription of "+nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle, "info");
            
            this.transcriptionRunning = true;
            this.initTranscription(nextInQueue).then(() => {
                this.app.addLog("Transcription of "+nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle+" complete", "info");
            }).catch(err => {
                this.app.addLog("Error starting transcription of "+nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle+": "+err, "error");
            }).finally(() => {
                this.transcriptionRunning = false;
            });
        }
        else {
            if(nextInQueue && nextInQueue.preProcessing == 'error') {
                //if the pre-processing failed, remove it from the queue by marking the item as errored
                nextInQueue.status = 'error';
                nextInQueue.updatedAt = new Date();
                await nextInQueue.save();
            }

            if(this.transcriptionDebug) {
                this.app.addLog("Not starting transcription of "+(nextInQueue ? nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle : "none")+" because:", "debug");
                if(this.transcriptionRunning) {
                    this.app.addLog("Transcription is already running", "debug");
                }
                if(nextInQueue) {
                    if(nextInQueue.preProcessing != 'complete') {
                        this.app.addLog("Pre-processing is not complete for "+nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle, "debug");
                    }
                    if(nextInQueue.status != 'queued') {
                        this.app.addLog("Status is not queued for "+nextInQueue.project+"/"+nextInQueue.session+"/"+nextInQueue.bundle, "debug");
                    }
                }
            }
        }

        this.notifyUsers();
    }

    async notifyUsers() {
        //check if any items have been transcribed and the user has not been notified, also check that ALL of the users files have been transcribed before sending out a notification
        const TranscriptionQueueItem = this.app.apiServer.mongoose.model('TranscriptionQueueItem');

        const uniqueUsers = await TranscriptionQueueItem.distinct('initiatedByUser', { status: 'complete', userNotified: false });
        uniqueUsers.forEach(async user => {
            let userItems = await TranscriptionQueueItem.find({ initiatedByUser: user, userNotified: false });
            let allItemsComplete = true;
            userItems.forEach(item => {
                if(item.status != 'complete' && item.status != 'error') {
                    allItemsComplete = false;
                }
            });

            if(allItemsComplete) {
                //send notification
                this.app.addLog("Sending transcription complete notification to user "+user, "info");
                this.notifyUser(user);

                //mark all items as userNotified
                userItems.forEach(async item => {
                    item.userNotified = true;
                    await item.save();
                });
            }
        });
    }

    async notifyUser(eppn) {
        //if the eppn is <something>@example.com then it is a test user and we should not send an email
        if(eppn.indexOf("@example.com") > -1) {
            return;
        }

        //email the user that their transcription is complete

        //get the mongoose model for User
        const User = this.app.apiServer.mongoose.model('User');
        let userObj = await User.findOne({ eppn: eppn });

        if(!userObj) {
            this.app.addLog("Error: User "+user+" does not exist", "error");
            return;
        }

        //send email
        this.transporter.sendMail({
            from: '"Humlab VISP system" <no-reply@visp.humlab.umu.se>',
            to: userObj.email,
            subject: 'VISP transcription complete',
            text: 'The trascription of your files is now complete. You can download the transcription files from the VISP interface at https://visp.humlab.umu.se'
        });
    }

    getFileNameWithoutExtension(fileName) {
        return fileName.split('.').slice(0, -1).join('.');
    }

    getRelativeAudioFilePath(project, session, bundle) {
        let bundleName = this.getFileNameWithoutExtension(bundle);
        return  `${project}/Data/VISP_emuDB/${session}_ses/${bundleName}_bndl/`;
    }

    async preProcessTranscription(queueItem) {
        this.app.addLog("Pre-processing file for transcription: "+queueItem.project+"/"+queueItem.session+"/"+queueItem.bundle, "info");
        queueItem.preProcessing = "running";
        queueItem.updatedAt = new Date();
        await queueItem.save();

        //convert the file to 16bit wav mono (with ffmpeg) and put the out in /transcription-queued/<project>/<session>/<bundle>.wav
        //then set the queueItem.preProcessing to complete

        let bundleFilenameWithoutExt = this.getFileNameWithoutExtension(queueItem.bundle);
        let sourcePath = "/repositories/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle);
        let destPath = "/transcription-queued/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle);
        if (!fs.existsSync(destPath)){
            fs.mkdirSync(destPath, { recursive: true });
        }

        try {
            fs.accessSync(destPath+"/"+bundleFilenameWithoutExt+".wav", fs.constants.R_OK);
            this.app.addLog("File already exists in destination path - skipping and marking as pre-processed.", "info");
            queueItem.preProcessing = "complete";
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return;
        } catch (err) { } 


        try {
            const ffmpegResult = execSync(`ffmpeg -i "${sourcePath}${queueItem.bundle}" -acodec pcm_s16le -ac 1 -ar 16000 "${destPath}${bundleFilenameWithoutExt}.wav"`, { stdio: 'pipe' });
            queueItem.error = "";
            queueItem.preProcessing = "complete";
            queueItem.updatedAt = new Date();
            await queueItem.save();
        } catch (err) {
            this.app.addLog("Error converting file to 16bit wav mono: " + err.toString(), "error");
            queueItem.error = "Error converting file to 16bit wav mono: " + err.toString();
            queueItem.status = 'error';
            queueItem.preProcessing = "error";
            queueItem.updatedAt = new Date();
            await queueItem.save();
        }
    }

    async initTranscription(queueItem) {
        let filePath = "/transcription-queued/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle);
        const outputPath = "/repositories/"+this.getRelativeAudioFilePath(queueItem.project, queueItem.session, queueItem.bundle);

        //check that filePath exists, if it doesn't then assume the pre-processed file was deleted and mark the queueItem for pre-processing again
        //but keep an eye on the preProcessingRuns so we don't get stuck in a loop
        queueItem.preProcessingRuns = queueItem.preProcessingRuns + 1;
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (err) {
            this.app.addLog(err, "warn");
            queueItem.error = "Error: "+err;
            if(queueItem.preProcessingRuns > 10) {
                queueItem.preProcessing = "error - too many tries";
            }
            else {
                queueItem.preProcessing = "queued";
            }
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return;
        }

        //mkdir outputPath
        if (!fs.existsSync(outputPath)){
            fs.mkdirSync(outputPath, { recursive: true });
        }
        
        queueItem.error = "";
        queueItem.status = 'running';
        queueItem.updatedAt = new Date();
        await queueItem.save();

        //make it lowercase, unless it is "Automatic Detection"
        const selectedLanguage = queueItem.language != "Automatic Detection" ? queueItem.language.toLowerCase() : queueItem.language;

        let fileBuffer = fs.readFileSync(filePath+queueItem.bundle);
        const fileBlob = new Blob([fileBuffer]);

        try {
            const result = await this.gradioConn.predict("/transcribe_file", {
                files: [fileBlob],
                input_folder_path: "",
                file_format: "SRT",
                add_timestamp: true,
                progress: "large-v2",
                param_5: selectedLanguage,
                param_6: false,
                param_7: 5, 		
                param_8: -1, 		
                param_9: 0.6, 		
                param_10: "float32", 		
                param_11: 5, 		
                param_12: 1, 		
                param_13: true, 		
                param_14: 0.5, 		
                param_15: "", 		
                param_16: 0, 		
                param_17: 2.4, 		
                param_18: 1, 		
                param_19: 1, 		
                param_20: 0,
                param_21: "",	
                param_22: true,
                param_23: "[-1]", 		
                param_24: 1, 		
                param_25: false, 		
                param_26: "\"'“¿([{-", 		
                param_27: "\"'.。,，!！?？:：”)]}、",
                param_28: 0,
                param_29: 30,
                param_30: 0,
                param_31: "",
                param_32: 0,
                param_33: 1,
                param_34: 24, 		
                param_35: false, 		
                param_36: 0.5, 		
                param_37: 250, 		
                param_38: 9999, 		
                param_39: 1000, 		
                param_40: 2000, 		
                param_41: false, 		
                param_42: "cpu", 		
                param_43: "", 		
                param_44: true, 		
                param_45: "UVR-MDX-NET-Inst_HQ_4", 		
                param_46: "cpu", 		
                param_47: 256, 		
                param_48: false, 		
                param_49: true, 
            });

            http.get(result.data[1][0].url, (response) => {
                if (response.statusCode !== 200) {
                    this.app.addLog("Failed to get transcription file: "+response.statusCode, "error");
                    return;
                }
            
                const fileStream = fs.createWriteStream(outputPath+'/transcription.srt');
                response.pipe(fileStream);
            
                fileStream.on('finish', () => {
                    fileStream.close();
                    this.convertSrtToTxt(outputPath);
                });
            
                fileStream.on('error', (err) => {
                    this.app.addLog("Error writing to transcription file: "+err, "error");
                });

            }).on('error', (err) => {
                this.app.addLog("Error downloading transcription file: "+err, "error");
            });

            queueItem.transcriptionData = result;
            queueItem.status = 'complete';
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return result;
        }
        catch(err) {
            let errStr = JSON.stringify(err);
            this.app.addLog("Error running whisper command: "+errStr, "error");
            queueItem.error = "Error running whisper command: "+errStr;
            queueItem.status = 'error';
            queueItem.updatedAt = new Date();
            await queueItem.save();
            return;
        }
    }

    convertSrtToTxt(path, writeToFile = true) {
        //now create txt version of the srt by strippping out the timecodes
        let srt = "";
        try {
            srt = fs.readFileSync(path+'/transcription.srt', 'utf8');
        }
        catch(err) {
            this.app.addLog("Error reading transcription file: "+err, "error");
            return;
        }

        // Regex to match SRT timestamps (e.g., 00:00:00,000 --> 00:00:04,000)
        const timestampRegex = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/gm;
        const indexLineRegex = /^\d+$/gm; // Matches index numbers like "1", "2", etc.
    
        // Remove timestamps and index lines
        const strippedContent = srt
        .replace(timestampRegex, '') // Remove timestamps
        .replace(indexLineRegex, '') // Remove index numbers
        .replace(/^\s*[\r\n]/gm, ''); // Remove empty lines

        if(writeToFile) {
            fs.writeFileSync(path+'/transcription.txt', strippedContent);
        }

        return strippedContent;
    }

    async shutdown() {
        await Promise.all(this.preProcessTranscriptionPromises);
        return true;
      }
}


module.exports = WhisperService;