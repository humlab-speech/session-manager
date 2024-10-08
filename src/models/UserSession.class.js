class UserSession {
    id; //int
    firstName; //str
    lastName; //str
    fullName; //str
    email; //str
    username; //str
    personalAccessToken; //str
    constructor(userSession) {
        this.importData(userSession);
    }

    importData(userSession) {
        this.id = userSession.username;
        this.firstName = userSession.firstName;
        this.lastName = userSession.lastName;
        this.fullName = userSession.fullName;
        this.email = userSession.email;
        this.username = userSession.username;
        this.eppn = userSession.eppn;
        this.accessListValidationPass = false;
        this.warnings = [];
        this.privileges = userSession.privileges;

        if(typeof this.id == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing id");
        }
        if(typeof this.firstName == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing firstName");
        }
        if(typeof this.lastName == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing lastName");
        }
        if(typeof this.fullName == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing fullName");
        }
        if(typeof this.email == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing email");
        }
        if(typeof this.username == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing username");
        }
        if(typeof this.eppn == "undefined") {
            this.warnings.push("Created a new user session object with incomplete data, missing eppn");
        }

        return this.warnings;
    }

    getBundleListName() {
        return this.username;
    }

    isDataValidAndComplete() {
        return this.warnings.length == 0;
    }

    printWarnings() {
        this.warnings.forEach(warning => {
            console.warn(warning);
        });
    }
}

module.exports = UserSession