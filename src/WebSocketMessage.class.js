class WebSocketMessage {
    /*
    context = ""; //This is a unique context/ID for a stream of messages.
    type = ""; //The type of message within this context (arbitrary)
    message = ""; //The actual data/message/payload
    params = ""; //Optional extra data to send along, usually a key/value object
    
    constructor(context, type = "", message = "", params = {}) {
        this.context = context;
        this.type = type;
        this.message = message;
        this.params = params;
    }
    
    toJSON() {
        return JSON.stringify({
            context: this.context,
            type: this.type,
            message: this.message,
            params: this.params
        });
    }

    */

    requestId = null; 
    cmd = "";
    data = {};
    message = "";
    progress = "";

    constructor(requestId, cmd, data = {}, message = null, progress = null, result = true) {
        this.requestId = requestId;
        this.cmd = cmd;
        this.data = data;
        this.message = message;
        this.progress = progress;
        this.result = result;
    }

    toJSON() {
        return JSON.stringify({
            requestId: this.requestId,
            cmd: this.cmd,
            data: this.data,
            message: this.message,
            progress: this.progress,
            result: this.result
        });
    }
}

module.exports = WebSocketMessage