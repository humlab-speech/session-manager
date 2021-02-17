class ApiResponse {
    constructor(code = 200, body = "") {
        this.code = code;
        this.body = body;
    }

    toJSON() {
        let msg = this.body;
        if(typeof msg !== 'object') {
            msg = { msg: this.body };
        }
        
        return JSON.stringify(msg);
    }
}

module.exports = ApiResponse